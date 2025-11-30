use rust_extension::draw::geometry::{LayerJSON, LayerBinary, SelectableObject, ObjectRange, PadStackDef};
use rust_extension::draw::drc::{DrcViolation, DrcRegion, DesignRules, run_full_drc, run_full_drc_with_regions};
use rust_extension::parse_xml::{parse_xml_file, XmlNode};
use rust_extension::draw::parsing::{extract_and_generate_layers, parse_padstack_definitions};
use rust_extension::serialize_xml::xml_node_to_file;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::time::Instant;
use std::collections::HashMap;
use std::fs::OpenOptions;
use rstar::RTree;
use indexmap::IndexMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;

#[cfg(windows)]
use std::mem::MaybeUninit;

/// Get current process memory usage on Windows (returns bytes)
#[cfg(windows)]
fn get_process_memory_bytes() -> Option<u64> {
    use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use winapi::um::processthreadsapi::GetCurrentProcess;
    
    unsafe {
        let mut pmc: MaybeUninit<PROCESS_MEMORY_COUNTERS> = MaybeUninit::uninit();
        let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        
        if GetProcessMemoryInfo(
            GetCurrentProcess(),
            pmc.as_mut_ptr(),
            cb,
        ) != 0 {
            let pmc = pmc.assume_init();
            // WorkingSetSize is the current memory in RAM
            Some(pmc.WorkingSetSize as u64)
        } else {
            None
        }
    }
}

/// Fallback for non-Windows platforms
#[cfg(not(windows))]
fn get_process_memory_bytes() -> Option<u64> {
    None
}

/// Track if we've already written to the log this session (to truncate on first write)
static LOG_INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Result from async DRC computation
struct DrcAsyncResult {
    regions: Vec<DrcRegion>,
    elapsed_ms: f64,
}

/// Helper to log to file for debugging (truncates on first write each session)
fn log_to_file(msg: &str) {
    // Use absolute path since LSP server may run from different working directory
    let log_path = if cfg!(windows) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("logs").join("lsp_debug.txt")
    } else {
        std::path::PathBuf::from("logs/lsp_debug.txt")
    };
    
    // On first write, truncate the file; afterwards append
    let is_first_write = !LOG_INITIALIZED.swap(true, Ordering::SeqCst);
    
    let file_result = if is_first_write {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
    } else {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
    };
    
    if let Ok(mut file) = file_result {
        let _ = writeln!(file, "{}", msg);
    }
}

/// Maximum number of undo/redo events to track


/// JSON-RPC Request format
#[derive(Debug, Deserialize)]
struct Request {
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

/// JSON-RPC Response format
#[derive(Debug, Serialize)]
struct Response {
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorResponse>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct TypedResponse<T: Serialize> {
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorResponse>,
}

/// In-memory state: DOM, layers, and layer colors
struct ServerState {
    xml_file_path: Option<String>,
    xml_root: Option<XmlNode>,
    layers: Vec<LayerJSON>,
    layer_colors: HashMap<String, [f32; 4]>, // layer_id -> RGBA (original from file)
    modified_colors: HashMap<String, [f32; 4]>, // layer_id -> RGBA (user-modified colors only)
    spatial_index: Option<RTree<SelectableObject>>,
    padstack_defs: IndexMap<String, PadStackDef>, // Padstack definitions for PTH detection
    // Undo/Redo stacks for deleted objects
    deleted_objects: HashMap<u64, ObjectRange>, // Currently deleted objects (id -> ObjectRange)
    // Hidden layers (layer visibility)
    hidden_layers: std::collections::HashSet<String>, // layer_id -> hidden
    // DRC state
    all_object_ranges: Vec<ObjectRange>, // All object ranges for DRC
    design_rules: DesignRules, // Design rules for DRC
    drc_violations: Vec<DrcViolation>, // Cached DRC violations
    drc_regions: Vec<DrcRegion>, // Cached DRC regions (fused violations with triangle data)
}

impl ServerState {
    fn new() -> Self {
        Self {
            xml_file_path: None,
            xml_root: None,
            layers: Vec::new(),
            layer_colors: HashMap::new(),
            modified_colors: HashMap::new(),
            spatial_index: None,
            padstack_defs: IndexMap::new(),
            deleted_objects: HashMap::new(),
            hidden_layers: std::collections::HashSet::new(),
            all_object_ranges: Vec::new(),
            design_rules: DesignRules::default(),
            drc_violations: Vec::new(),
            drc_regions: Vec::new(),
        }
    }
}

fn main() {
    eprintln!("[LSP Server] Starting IPC-2581 LSP server...");
    let mut state = ServerState::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    
    // Channel for async DRC results
    let (drc_tx, drc_rx): (Sender<DrcAsyncResult>, Receiver<DrcAsyncResult>) = mpsc::channel();
    let mut drc_sender: Option<Sender<DrcAsyncResult>> = Some(drc_tx);

    for line in stdin.lock().lines() {
        // Check for completed DRC results (non-blocking)
        match drc_rx.try_recv() {
            Ok(result) => {
                let region_count = result.regions.len();
                let total_triangles: usize = result.regions.iter().map(|r| r.triangle_count).sum();
                
                eprintln!("[LSP Server] Async DRC completed: {} regions, {} triangles in {:.2}ms", 
                    region_count, total_triangles, result.elapsed_ms);
                
                // Store regions in state
                state.drc_regions = result.regions;
                
                // Send notification to client
                let notification = serde_json::json!({
                    "id": null,
                    "method": "drcComplete",
                    "result": {
                        "status": "ok",
                        "region_count": region_count,
                        "total_triangles": total_triangles,
                        "elapsed_ms": result.elapsed_ms,
                        "regions": &state.drc_regions
                    }
                });
                writeln!(stdout, "{}", notification.to_string()).unwrap();
                stdout.flush().unwrap();
            }
            Err(TryRecvError::Empty) => {} // No result yet, continue
            Err(TryRecvError::Disconnected) => {
                // Channel closed, recreate it
                let (tx, _rx) = mpsc::channel();
                drc_sender = Some(tx);
                // Note: rx would need to be reassigned but we can't in this loop
                // This case shouldn't happen in normal operation
            }
        }
        
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[LSP Server] Error reading stdin: {}", e);
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("[LSP Server] Failed to parse request: {}", e);
                continue;
            }
        };

        let response_json = match request.method.as_str() {
            "Load" => serde_json::to_string(&handle_load(&mut state, request.id, request.params)).unwrap(),
            "GetLayers" => serde_json::to_string(&handle_get_layers(&state, request.id)).unwrap(),
            "GetTessellation" => handle_get_tessellation_json(&mut state, request.id, request.params),
            "GetTessellationBinary" => handle_get_tessellation_binary(&mut state, request.id, request.params),
            "UpdateLayerColor" => serde_json::to_string(&handle_update_layer_color(&mut state, request.id, request.params)).unwrap(),
            "SetLayerVisibility" => serde_json::to_string(&handle_set_layer_visibility(&mut state, request.id, request.params)).unwrap(),
            "Save" => serde_json::to_string(&handle_save(&mut state, request.id, request.params)).unwrap(),
            "Select" => serde_json::to_string(&handle_select(&state, request.id, request.params)).unwrap(),
            "BoxSelect" => serde_json::to_string(&handle_box_select(&state, request.id, request.params)).unwrap(),
            "Delete" => serde_json::to_string(&handle_delete(&mut state, request.id, request.params)).unwrap(),
            "Undo" => serde_json::to_string(&handle_undo(&mut state, request.id, request.params)).unwrap(),
            "Redo" => serde_json::to_string(&handle_redo(&mut state, request.id, request.params)).unwrap(),
            "HighlightSelectedNets" => serde_json::to_string(&handle_highlight_selected_nets(&state, request.id, request.params)).unwrap(),
            "HighlightSelectedComponents" => serde_json::to_string(&handle_highlight_selected_components(&state, request.id, request.params)).unwrap(),
            "QueryNetAtPoint" => serde_json::to_string(&handle_query_net_at_point(&state, request.id, request.params)).unwrap(),
            "RunDRC" => serde_json::to_string(&handle_run_drc(&mut state, request.id, request.params)).unwrap(),
            "GetDRCViolations" => serde_json::to_string(&handle_get_drc_violations(&state, request.id)).unwrap(),
            "RunDRCWithRegions" => {
                // Run DRC asynchronously
                handle_run_drc_with_regions_async(&state, request.id, request.params, drc_sender.clone())
            },
            "GetDRCRegions" => serde_json::to_string(&handle_get_drc_regions(&state, request.id)).unwrap(),
            "GetMemory" => serde_json::to_string(&handle_get_memory(request.id)).unwrap(),
            "Close" => serde_json::to_string(&handle_close(&mut state, request.id)).unwrap(),
            _ => {
                let response = Response {
                    id: request.id,
                    result: None,
                    error: Some(ErrorResponse {
                        code: -32601,
                        message: format!("Method not found: {}", request.method),
                    }),
                };
                serde_json::to_string(&response).unwrap()
            },
        };

        writeln!(stdout, "{}", response_json).unwrap();
        stdout.flush().unwrap();
    }

    eprintln!("[LSP Server] Shutting down...");
}

fn handle_load(state: &mut ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct LoadParams {
        file_path: String,
    }

    let params: LoadParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {file_path: string}".to_string(),
                }),
            };
        }
    };

    eprintln!("[LSP Server] Loading file: {}", params.file_path);

    let start_total = Instant::now();

    // Parse XML file
    let start_parse = Instant::now();
    let root = match parse_xml_file(&params.file_path) {
        Ok(doc) => doc,
        Err(e) => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 1,
                    message: format!("Failed to parse XML: {}", e),
                }),
            };
        }
    };
    eprintln!("[LSP Server] XML Parse time: {:.2?}", start_parse.elapsed());

    // Extract and generate layer geometries
    let start_gen = Instant::now();
    let (layers, object_ranges) = match extract_and_generate_layers(&root) {
        Ok((layers, ranges)) => (layers, ranges),
        Err(e) => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 1,
                    message: format!("Failed to generate layers: {}", e),
                }),
            };
        }
    };
    eprintln!("[LSP Server] Layer Generation (Tessellation) time: {:.2?}", start_gen.elapsed());
    
    // Debug: Count objects with net_name and component_ref
    let objects_with_net = object_ranges.iter().filter(|o| o.net_name.is_some()).count();
    let objects_with_component = object_ranges.iter().filter(|o| o.component_ref.is_some()).count();
    let pads = object_ranges.iter().filter(|o| o.obj_type == 3).count();
    let vias = object_ranges.iter().filter(|o| o.obj_type == 2).count();
    eprintln!("[LSP Server] Object stats: {} total, {} pads, {} vias, {} with net, {} with component",
        object_ranges.len(), pads, vias, objects_with_net, objects_with_component);
    
    // Keep a copy of object_ranges for DRC before consuming it for spatial index
    let all_object_ranges = object_ranges.clone();
    
    // Build spatial index
    let start_index = Instant::now();
    let selectable_objects: Vec<SelectableObject> = object_ranges.into_iter()
        .map(SelectableObject::new)
        .collect();
    let spatial_index = RTree::bulk_load(selectable_objects);
    eprintln!("[LSP Server] Spatial Index build time: {:.2?}", start_index.elapsed());
    
    // Parse padstack definitions for PTH pad detection during save
    let padstack_defs = parse_padstack_definitions(&root);
    eprintln!("[LSP Server] Parsed {} padstack definitions", padstack_defs.len());
    
    eprintln!("[LSP Server] Total Load time: {:.2?}", start_total.elapsed());

    eprintln!("[LSP Server] Generated {} layers", layers.len());

    // Parse DictionaryColor from XML to get layer colors
    let layer_colors = parse_dictionary_colors(&root);
    eprintln!("[LSP Server] Parsed {} layer colors from DictionaryColor", layer_colors.len());

    // Apply DictionaryColor values to layers
    let mut layers = layers;
    for layer in &mut layers {
        // Check both with and without LAYER_COLOR_ prefix
        let color_key = format!("LAYER_COLOR_{}", layer.layer_id);
        if let Some(&color) = layer_colors.get(&color_key) {
            layer.default_color = color;
        } else if let Some(&color) = layer_colors.get(&layer.layer_id) {
            layer.default_color = color;
        }
    }

    state.xml_file_path = Some(params.file_path.clone());
    // Don't store xml_root - we'll re-parse on save to reduce memory usage
    // xml_root was ~125 MB for a 14 MB file, this saves significant memory
    state.xml_root = None;
    state.layers = layers;
    state.layer_colors = layer_colors;
    state.spatial_index = Some(spatial_index);
    state.padstack_defs = padstack_defs;
    state.all_object_ranges = all_object_ranges;
    // Clear old DRC violations when loading new file
    state.drc_violations.clear();

    // Log memory savings
    eprintln!("[LSP Server] File loaded successfully (xml_root dropped to save memory)");

    Response {
        id,
        result: Some(serde_json::json!({
            "status": "ok",
            "file_path": params.file_path
        })),
        error: None,
    }
}

fn handle_get_layers(state: &ServerState, id: Option<serde_json::Value>) -> Response {
    if state.xml_file_path.is_none() {
        return Response {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
    }

    // Return layer IDs from the parsed layers
    let layer_ids: Vec<String> = state.layers.iter().map(|l| l.layer_id.clone()).collect();

    Response {
        id,
        result: Some(serde_json::to_value(layer_ids).unwrap()),
        error: None,
    }
}

fn handle_get_tessellation_json(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> String {
    #[derive(Deserialize)]
    struct TessellationParams {
        layer_id: String,
    }

    let params: TessellationParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {layer_id: string}".to_string(),
                }),
            };
            return serde_json::to_string(&response).unwrap();
        }
    };

    if state.xml_file_path.is_none() {
        let response = TypedResponse::<()> {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
        return serde_json::to_string(&response).unwrap();
    }

    eprintln!("[LSP Server] Tessellating layer: {}", params.layer_id);

    // Find the layer in the generated layers
    let layer = state.layers.iter().find(|l| l.layer_id == params.layer_id);

    match layer {
        Some(layer_json) => {
            let start_serialize = Instant::now();
            
            let response = TypedResponse {
                id,
                result: Some(layer_json),
                error: None,
            };
            
            let result_string = serde_json::to_string(&response).unwrap();
            eprintln!("[LSP Server] Serialization time for layer {}: {:.2?}", params.layer_id, start_serialize.elapsed());

            eprintln!("[LSP Server] Returning tessellation for layer: {}", params.layer_id);

            result_string
        }
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 3,
                    message: format!("Layer not found: {}", params.layer_id),
                }),
            };
            serde_json::to_string(&response).unwrap()
        }
    }
}

/// Handle GetTessellationBinary request - returns binary data with special prefix
fn handle_get_tessellation_binary(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> String {
    #[derive(Deserialize)]
    struct TessellationParams {
        layer_id: String,
    }

    let params: TessellationParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {layer_id: string}".to_string(),
                }),
            };
            return serde_json::to_string(&response).unwrap();
        }
    };

    if state.xml_file_path.is_none() {
        let response = TypedResponse::<()> {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
        return serde_json::to_string(&response).unwrap();
    }

    eprintln!("[LSP Server] Binary tessellating layer: {}", params.layer_id);

    // Find the layer in the generated layers
    let layer = state.layers.iter().find(|l| l.layer_id == params.layer_id);

    match layer {
        Some(layer_json) => {
            let start_serialize = Instant::now();
            
            // Convert to binary format
            let layer_binary = LayerBinary::from_layer_json(layer_json);
            let binary_data = layer_binary.to_bytes();
            
            eprintln!("[LSP Server] Binary serialization time for layer {}: {:.2?}, size: {} bytes", 
                params.layer_id, start_serialize.elapsed(), binary_data.len());

            // Return special binary response format:
            // Format: BINARY:<base64_encoded_id>:<base64_encoded_binary_data>
            // This allows dev-server to detect binary responses and handle appropriately
            let id_str = match &id {
                Some(serde_json::Value::Number(n)) => n.to_string(),
                Some(serde_json::Value::String(s)) => s.clone(),
                _ => "null".to_string(),
            };
            
            // Use base64 for the binary data to safely transmit over stdio
            use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
            let encoded_data = BASE64.encode(&binary_data);
            
            format!("BINARY:{}:{}", id_str, encoded_data)
        }
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 3,
                    message: format!("Layer not found: {}", params.layer_id),
                }),
            };
            serde_json::to_string(&response).unwrap()
        }
    }
}

/// Parse DictionaryColor from XML root to extract layer colors
fn parse_dictionary_colors(root: &XmlNode) -> HashMap<String, [f32; 4]> {
    let mut colors = HashMap::new();
    
    // Find Content > DictionaryColor
    if let Some(content) = root.children.iter().find(|n| n.name == "Content") {
        if let Some(dict_color) = content.children.iter().find(|n| n.name == "DictionaryColor") {
            for entry in &dict_color.children {
                if entry.name == "EntryColor" {
                    if let Some(id) = entry.attributes.get("id") {
                        // Find Color child element
                        if let Some(color_node) = entry.children.iter().find(|n| n.name == "Color") {
                            let r = color_node.attributes.get("r")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            let g = color_node.attributes.get("g")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            let b = color_node.attributes.get("b")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            
                            colors.insert(id.clone(), [r, g, b, 1.0]);
                        }
                    }
                }
            }
        }
    }
    
    colors
}

/// Handle UpdateLayerColor request - updates layer color in memory
fn handle_update_layer_color(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct UpdateColorParams {
        layer_id: String,
        color: [f32; 4], // RGBA
    }

    let params: UpdateColorParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {layer_id: string, color: [f32; 4]}".to_string(),
                }),
            };
        }
    };

    if state.xml_file_path.is_none() {
        return Response {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
    }

    eprintln!("[LSP Server] Updating color for layer {}: {:?}", params.layer_id, params.color);

    // Ensure we use the LAYER_COLOR_ prefix for storage
    let color_key = if params.layer_id.starts_with("LAYER_COLOR_") {
        params.layer_id.clone()
    } else {
        format!("LAYER_COLOR_{}", params.layer_id)
    };

    // Store in modified_colors to track user changes (for save)
    state.modified_colors.insert(color_key.clone(), params.color);
    
    // Also update layer_colors so the UI sees the change
    state.layer_colors.insert(color_key, params.color);

    // Update layer's default_color if it exists
    if let Some(layer) = state.layers.iter_mut().find(|l| l.layer_id == params.layer_id) {
        layer.default_color = params.color;
    }

    Response {
        id,
        result: Some(serde_json::json!({
            "status": "ok"
        })),
        error: None,
    }
}

/// Handle SetLayerVisibility request - updates layer visibility state
fn handle_set_layer_visibility(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct SetVisibilityParams {
        layer_id: String,
        visible: bool,
    }

    let params: SetVisibilityParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {layer_id: string, visible: bool}".to_string(),
                }),
            };
        }
    };

    eprintln!("[LSP Server] Setting layer {} visibility to {}", params.layer_id, params.visible);

    if params.visible {
        state.hidden_layers.remove(&params.layer_id);
    } else {
        state.hidden_layers.insert(params.layer_id.clone());
    }

    Response {
        id,
        result: Some(serde_json::json!({
            "status": "ok"
        })),
        error: None,
    }
}

/// Handle Save request - serializes XML with updated colors to disk
fn handle_save(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct SaveParams {
        #[serde(default)]
        file_path: Option<String>,
    }

    let params: SaveParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => SaveParams { file_path: None },
    };

    if state.xml_file_path.is_none() {
        return Response {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
    }

    let original_path = state.xml_file_path.as_ref().unwrap();
    
    // Generate output path: add _serialized before extension
    let output_path = params.file_path.unwrap_or_else(|| {
        let path = std::path::Path::new(original_path);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("xml");
        let parent = path.parent().unwrap_or(std::path::Path::new("."));
        parent.join(format!("{}_serialized.{}", stem, ext))
            .to_string_lossy()
            .to_string()
    });

    eprintln!("[LSP Server] Saving file to: {}", output_path);
    eprintln!("[LSP Server] Deleted objects count: {}", state.deleted_objects.len());
    
    // Log deleted objects for debugging
    for (obj_id, range) in &state.deleted_objects {
        eprintln!("[LSP Server]   Deleted: id={}, layer={}, type={}", obj_id, range.layer_id, range.obj_type);
    }

    // Re-parse the original XML file (we don't keep xml_root in memory to save ~125 MB)
    let start_parse = std::time::Instant::now();
    let mut root = match parse_xml_file(original_path) {
        Ok(r) => r,
        Err(e) => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 5,
                    message: format!("Failed to re-parse XML for save: {}", e),
                }),
            };
        }
    };
    eprintln!("[LSP Server] Re-parsed XML in {:.2?}", start_parse.elapsed());
    
    // Only update DictionaryColor if user actually changed colors
    if !state.modified_colors.is_empty() {
        update_dictionary_colors(&mut root, &state.modified_colors);
        eprintln!("[LSP Server] Updated {} modified colors", state.modified_colors.len());
    }
    
    // Remove deleted objects from XML
    if !state.deleted_objects.is_empty() {
        let removed_count = remove_deleted_objects_from_xml(&mut root, &state.deleted_objects, &state.layers, &state.padstack_defs);
        eprintln!("[LSP Server] Removed {} objects from XML", removed_count);
    }

    // Serialize to file
    match xml_node_to_file(&root, &output_path) {
        Ok(_) => {
            let deleted_count = state.deleted_objects.len();
            eprintln!("[LSP Server] File saved successfully");
            Response {
                id,
                result: Some(serde_json::json!({
                    "status": "ok",
                    "file_path": output_path,
                    "deleted_objects_count": deleted_count
                })),
                error: None,
            }
        }
        Err(e) => {
            Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 4,
                    message: format!("Failed to save file: {}", e),
                }),
            }
        }
    }
}

/// Update DictionaryColor in XML tree with only the modified layer colors
/// Preserves existing entries that weren't changed by the user
fn update_dictionary_colors(root: &mut XmlNode, modified_colors: &HashMap<String, [f32; 4]>) {
    // Find Content node
    let content = match root.children.iter_mut().find(|n| n.name == "Content") {
        Some(c) => c,
        None => return, // No Content node, nothing to update
    };
    
    // Find DictionaryColor
    let dict_color = match content.children.iter_mut().find(|n| n.name == "DictionaryColor") {
        Some(d) => d,
        None => {
            // No DictionaryColor exists, create one with only modified colors
            let mut new_dict = XmlNode {
                name: "DictionaryColor".to_string(),
                attributes: indexmap::IndexMap::new(),
                children: Vec::new(),
                text_content: String::new(),
            };
            
            for (layer_id, color) in modified_colors {
                new_dict.children.push(create_entry_color(layer_id, color));
            }
            
            // Insert at start of Content
            content.children.insert(0, new_dict);
            return;
        }
    };
    
    // Update existing entries or add new ones
    for (layer_id, color) in modified_colors {
        // Try to find existing entry with this id
        let existing = dict_color.children.iter_mut().find(|entry| {
            entry.name == "EntryColor" && 
            entry.attributes.get("id").map(|s| s.as_str()) == Some(layer_id.as_str())
        });
        
        if let Some(entry) = existing {
            // Update existing Color child
            if let Some(color_node) = entry.children.iter_mut().find(|n| n.name == "Color") {
                let r = (color[0] * 255.0).round() as u8;
                let g = (color[1] * 255.0).round() as u8;
                let b = (color[2] * 255.0).round() as u8;
                color_node.attributes.insert("r".to_string(), r.to_string());
                color_node.attributes.insert("g".to_string(), g.to_string());
                color_node.attributes.insert("b".to_string(), b.to_string());
            }
        } else {
            // Add new entry
            dict_color.children.push(create_entry_color(layer_id, color));
        }
    }
}

/// Helper to create an EntryColor node
fn create_entry_color(layer_id: &str, color: &[f32; 4]) -> XmlNode {
    let mut entry_attrs = indexmap::IndexMap::new();
    entry_attrs.insert("id".to_string(), layer_id.to_string());
    
    let r = (color[0] * 255.0).round() as u8;
    let g = (color[1] * 255.0).round() as u8;
    let b = (color[2] * 255.0).round() as u8;
    
    let mut color_attrs = indexmap::IndexMap::new();
    color_attrs.insert("r".to_string(), r.to_string());
    color_attrs.insert("g".to_string(), g.to_string());
    color_attrs.insert("b".to_string(), b.to_string());
    
    XmlNode {
        name: "EntryColor".to_string(),
        attributes: entry_attrs,
        children: vec![XmlNode {
            name: "Color".to_string(),
            attributes: color_attrs,
            children: Vec::new(),
            text_content: String::new(),
        }],
        text_content: String::new(),
    }
}

/// Remove deleted objects from XML tree
/// Returns the number of objects removed
fn remove_deleted_objects_from_xml(
    root: &mut XmlNode,
    deleted_objects: &HashMap<u64, ObjectRange>,
    _layers: &[LayerJSON],
    padstack_defs: &IndexMap<String, PadStackDef>,
) -> usize {
    // Build a map of layer_id -> set of deleted object indices by type
    // ID format: (layer_index << 40) | (obj_type << 36) | object_index
    let mut deleted_by_layer: HashMap<String, HashMap<u8, std::collections::HashSet<usize>>> = HashMap::new();
    
    for (id, range) in deleted_objects {
        let obj_index = (*id & 0xFFFFFFFFF) as usize; // Lower 36 bits
        let obj_type = range.obj_type;
        
        eprintln!("[XML Remove] Marking for deletion: layer={}, obj_type={}, index={}", range.layer_id, obj_type, obj_index);
        
        deleted_by_layer
            .entry(range.layer_id.clone())
            .or_default()
            .entry(obj_type)
            .or_default()
            .insert(obj_index);
    }
    
    let mut total_removed = 0;
    
    // Now traverse the XML and remove matching elements
    // We need to find LayerFeature nodes and track object indices
    // Also track if we're inside a Set with padUsage="VIA"
    fn process_node(
        node: &mut XmlNode,
        deleted_by_layer: &HashMap<String, HashMap<u8, std::collections::HashSet<usize>>>,
        current_layer: Option<&str>,
        in_via_set: bool,  // Track if we're inside a Set with padUsage="VIA"
        counters: &mut HashMap<String, HashMap<u8, usize>>, // layer -> type -> count
        removed: &mut usize,
        padstack_defs: &IndexMap<String, PadStackDef>,
    ) {
        // Check if this is a LayerFeature - updates current layer context
        let layer_ref = if node.name == "LayerFeature" {
            node.attributes.get("layerRef").map(|s| s.as_str())
        } else {
            current_layer
        };
        
        // Check if this node is or contains a Set with padUsage="VIA"
        let is_via_set = node.name == "Set" && 
            node.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
        let child_in_via_set = in_via_set || is_via_set;
        
        // Check if this node should be removed and get its object type
        let check_should_remove = |child: &XmlNode, layer: Option<&str>, parent_in_via_set: bool, counters: &mut HashMap<String, HashMap<u8, usize>>, padstack_defs: &IndexMap<String, PadStackDef>| -> Option<bool> {
            let layer_id = match layer {
                Some(l) => l,
                None => return None,
            };
            
            // Determine object type - returns None if not a tracked element
            let obj_type = match child.name.as_str() {
                "Polyline" | "Line" => Some(0u8),
                "Polygon" => Some(1u8),
                "Pad" => {
                    // Check if it's a via (obj_type 2):
                    // 1. Has padUsage="VIA" directly on the Pad
                    // 2. Is inside a Set with padUsage="VIA"
                    // 3. Has a padstack with a hole > 0.01mm (PTH pad - treated same as via)
                    let has_via_attr = child.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
                    let in_via_set = parent_in_via_set;
                    
                    // Check if this is a PTH pad (has hole in padstack)
                    let is_pth = if let Some(padstack_ref) = child.attributes.get("padstackDefRef") {
                        if let Some(def) = padstack_defs.get(padstack_ref) {
                            def.hole_diameter > 0.01
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    
                    if has_via_attr || in_via_set || is_pth {
                        Some(2u8) // Via / PTH pad
                    } else {
                        Some(3u8) // SMD Pad
                    }
                }
                _ => None,
            };
            
            let obj_type = match obj_type {
                Some(t) => t,
                None => return None,
            };
            
            // Get current count for this type in this layer
            let count = counters
                .entry(layer_id.to_string())
                .or_default()
                .entry(obj_type)
                .or_insert(0);
            
            let current_idx = *count;
            *count += 1;
            
            // Check if this index is in the deleted set
            let deleted_for_layer = deleted_by_layer.get(layer_id);
            if let Some(deleted_for_layer) = deleted_for_layer {
                if let Some(deleted_indices) = deleted_for_layer.get(&obj_type) {
                    if deleted_indices.contains(&current_idx) {
                        eprintln!("[XML Remove] Removing {} at index {} from layer {}", child.name, current_idx, layer_id);
                        return Some(true);
                    }
                }
            }
            
            Some(false)
        };
        
        // Process children - need to remove some and recurse into others
        let mut i = 0;
        while i < node.children.len() {
            let child = &node.children[i];
            
            match check_should_remove(child, layer_ref, child_in_via_set, counters, padstack_defs) {
                Some(true) => {
                    node.children.remove(i);
                    *removed += 1;
                    // Don't increment i, the next element is now at position i
                }
                _ => {
                    // Recurse into this child
                    let child_mut = &mut node.children[i];
                    process_node(child_mut, deleted_by_layer, layer_ref, child_in_via_set, counters, removed, padstack_defs);
                    i += 1;
                }
            }
        }
    }
    
    let mut counters: HashMap<String, HashMap<u8, usize>> = HashMap::new();
    process_node(root, &deleted_by_layer, None, false, &mut counters, &mut total_removed, padstack_defs);
    
    eprintln!("[XML Remove] Total removed: {}", total_removed);
    total_removed
}

/// Check if a point is inside a triangle using barycentric coordinates
fn point_in_triangle(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> bool {
    let area = 0.5 * (-y1 * x2 + y0 * (-x1 + x2) + x0 * (y1 - y2) + x1 * y2);
    if area.abs() < 1e-10 {
        return false; // Degenerate triangle
    }
    let s = (y0 * x2 - x0 * y2 + (y2 - y0) * px + (x0 - x2) * py) / (2.0 * area);
    let t = (x0 * y1 - y0 * x1 + (y0 - y1) * px + (x1 - x0) * py) / (2.0 * area);
    s >= 0.0 && t >= 0.0 && (s + t) <= 1.0
}

/// Check if a point hits an object's actual geometry (not just bounding box)
fn point_hits_object(px: f32, py: f32, range: &ObjectRange, layers: &[LayerJSON]) -> bool {
    // Find the layer this object belongs to
    let layer = match layers.iter().find(|l| l.layer_id == range.layer_id) {
        Some(l) => l,
        None => return true, // If layer not found, fall back to AABB (already passed)
    };
    
    // Get the geometry based on object type
    let geometry = match range.obj_type {
        0 => layer.geometry.batch.as_ref(),           // Polyline
        1 => layer.geometry.batch_colored.as_ref(),   // Polygon
        2 => layer.geometry.instanced.as_ref(),       // Via (instanced)
        3 => layer.geometry.instanced_rot.as_ref(),   // Pad (instanced with rotation)
        _ => return true, // Unknown type, fall back to AABB
    };
    
    let lods = match geometry {
        Some(lods) if !lods.is_empty() => lods,
        _ => return true, // No geometry data, fall back to AABB
    };
    
    // Use LOD0 for precise hit testing
    // For instanced geometry (pads/vias), we need to find the correct LOD entry using shape_index
    // The LOD entries are organized as: all LOD0 entries, then all LOD1, then all LOD2
    // So LOD0 entry for shape N is at index N
    
    // Handle instanced geometry (vias, pads)
    if range.obj_type == 2 || range.obj_type == 3 {
        // Get the correct LOD entry for this shape
        let shape_idx = range.shape_index.unwrap_or(0) as usize;
        if shape_idx >= lods.len() {
            return true; // Shape index out of bounds, fall back to AABB
        }
        let lod_entry = &lods[shape_idx];
        
        // For instanced geometry, check if point is within the instance's bounds
        // The instance position is stored in instance_data
        if let (Some(inst_data), Some(inst_idx)) = (&lod_entry.instance_data, range.instance_index) {
            let floats_per_instance = if range.obj_type == 3 { 3 } else { 3 }; // x, y, packed_rot_vis
            let base = (inst_idx as usize) * floats_per_instance;
            if base + 1 < inst_data.len() {
                let inst_x = inst_data[base];
                let inst_y = inst_data[base + 1];
                
                // Check triangles of the base shape, offset by instance position
                if let Some(ref indices) = lod_entry.index_data {
                    for tri in indices.chunks(3) {
                        if tri.len() < 3 { continue; }
                        let i0 = tri[0] as usize * 2;
                        let i1 = tri[1] as usize * 2;
                        let i2 = tri[2] as usize * 2;
                        
                        if i2 + 1 < lod_entry.vertex_data.len() {
                            let x0 = lod_entry.vertex_data[i0] + inst_x;
                            let y0 = lod_entry.vertex_data[i0 + 1] + inst_y;
                            let x1 = lod_entry.vertex_data[i1] + inst_x;
                            let y1 = lod_entry.vertex_data[i1 + 1] + inst_y;
                            let x2 = lod_entry.vertex_data[i2] + inst_x;
                            let y2 = lod_entry.vertex_data[i2 + 1] + inst_y;
                            
                            if point_in_triangle(px, py, x0, y0, x1, y1, x2, y2) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }
    
    // For batched geometry (polylines, polygons), use vertex_ranges to find our triangles
    let lod0 = &lods[0];
    if range.vertex_ranges.is_empty() {
        return true; // No vertex range info, fall back to AABB
    }
    
    let (start_vertex, vertex_count) = range.vertex_ranges[0]; // LOD0
    if vertex_count == 0 {
        return false; // Object was culled at this LOD
    }
    
    // Get the indices that reference vertices in our range
    if let Some(ref indices) = lod0.index_data {
        let start = start_vertex as usize;
        let end = start + vertex_count as usize;
        
        for tri in indices.chunks(3) {
            if tri.len() < 3 { continue; }
            
            // Check if this triangle uses vertices from our object's range
            let idx0 = tri[0] as usize;
            let idx1 = tri[1] as usize;
            let idx2 = tri[2] as usize;
            
            // For batched geometry, triangles use absolute indices
            // We need to check if these indices fall within our vertex range
            if idx0 >= start && idx0 < end && idx1 >= start && idx1 < end && idx2 >= start && idx2 < end {
                let i0 = idx0 * 2;
                let i1 = idx1 * 2;
                let i2 = idx2 * 2;
                
                if i2 + 1 < lod0.vertex_data.len() {
                    let x0 = lod0.vertex_data[i0];
                    let y0 = lod0.vertex_data[i0 + 1];
                    let x1 = lod0.vertex_data[i1];
                    let y1 = lod0.vertex_data[i1 + 1];
                    let x2 = lod0.vertex_data[i2];
                    let y2 = lod0.vertex_data[i2 + 1];
                    
                    if point_in_triangle(px, py, x0, y0, x1, y1, x2, y2) {
                        return true;
                    }
                }
            }
        }
    }
    
    false
}

/// Handle Select request - performs spatial selection based on x, y coordinates
fn handle_select(state: &ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct SelectParams {
        x: f32,
        y: f32,
    }

    let params: SelectParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {x: number, y: number}".to_string(),
                }),
            };
        }
    };

    if let Some(tree) = &state.spatial_index {
        let point = [params.x, params.y];
        // Find all objects whose AABB contains the point (coarse phase)
        let candidates: Vec<&SelectableObject> = tree.locate_all_at_point(&point).collect();
        
        // Fine phase: filter using actual geometry
        let mut results: Vec<ObjectRange> = candidates.iter()
            .filter(|obj| point_hits_object(params.x, params.y, &obj.range, &state.layers))
            .map(|obj| obj.range.clone())
            .collect();
        
        // Sort by priority: 
        // 1. Objects with net_name come before those without
        // 2. Within that, pads (3) and vias (2) come first
        // This ensures we select the copper layer pad (with net) over paste/mask pads (no net)
        results.sort_by(|a, b| {
            // First priority: has net_name vs doesn't
            let has_net_priority = |r: &ObjectRange| if r.net_name.is_some() { 0 } else { 1 };
            let net_cmp = has_net_priority(a).cmp(&has_net_priority(b));
            if net_cmp != std::cmp::Ordering::Equal {
                return net_cmp;
            }
            
            // Second priority: pad=3 > via=2 > polygon=1 > polyline=0
            let type_priority = |t: u8| match t {
                3 => 0, // Pad - highest priority
                2 => 1, // Via
                1 => 2, // Polygon
                _ => 3, // Polyline and others
            };
            type_priority(a.obj_type).cmp(&type_priority(b.obj_type))
        });
            
        Response {
            id,
            result: Some(serde_json::to_value(results).unwrap()),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!([])),
            error: None,
        }
    }
}

/// Handle BoxSelect request - performs spatial selection for a rectangular region
fn handle_box_select(state: &ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct BoxSelectParams {
        min_x: f32,
        min_y: f32,
        max_x: f32,
        max_y: f32,
    }

    let params: BoxSelectParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {min_x, min_y, max_x, max_y}".to_string(),
                }),
            };
        }
    };

    eprintln!("[LSP Server] BoxSelect: ({}, {}) to ({}, {})", 
        params.min_x, params.min_y, params.max_x, params.max_y);

    if let Some(tree) = &state.spatial_index {
        use rstar::AABB;
        
        // Create envelope for the selection box
        let envelope = AABB::from_corners(
            [params.min_x, params.min_y],
            [params.max_x, params.max_y]
        );
        
        // Find all objects that intersect with the selection box
        let mut results: Vec<ObjectRange> = tree.locate_in_envelope_intersecting(&envelope)
            .map(|obj| obj.range.clone())
            .collect();
        
        // Sort by priority: 
        // 1. Objects with net_name come before those without
        // 2. Within that, pads (3) and vias (2) come first
        results.sort_by(|a, b| {
            // First priority: has net_name vs doesn't
            let has_net_priority = |r: &ObjectRange| if r.net_name.is_some() { 0 } else { 1 };
            let net_cmp = has_net_priority(a).cmp(&has_net_priority(b));
            if net_cmp != std::cmp::Ordering::Equal {
                return net_cmp;
            }
            
            // Second priority: pad=3 > via=2 > polygon=1 > polyline=0
            let type_priority = |t: u8| match t {
                3 => 0, // Pad - highest priority
                2 => 1, // Via
                1 => 2, // Polygon
                _ => 3, // Polyline and others
            };
            type_priority(a.obj_type).cmp(&type_priority(b.obj_type))
        });
        
        eprintln!("[LSP Server] BoxSelect found {} objects", results.len());
            
        Response {
            id,
            result: Some(serde_json::to_value(results).unwrap()),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!([])),
            error: None,
        }
    }
}

/// Handle Delete request - marks an object as deleted
/// For vias (obj_type=2), this also deletes all vias at the same location across all layers
fn handle_delete(state: &mut ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    let range: ObjectRange = match params.and_then(|p| {
        // The webview sends { object: ObjectRange }
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    }) {
        Some(r) => r,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {object: ObjectRange}".to_string(),
                }),
            };
        }
    };

    let mut related_objects: Vec<ObjectRange> = Vec::new();
    
    // For vias, find and delete all vias at the same location across all layers
    if range.obj_type == 2 {
        // Get the center position of this via from its bounds
        let via_x = (range.bounds[0] + range.bounds[2]) / 2.0;
        let via_y = (range.bounds[1] + range.bounds[3]) / 2.0;
        let tolerance = 0.1; // Tolerance for floating point comparison (was 0.01, might be too tight)
        
        if let Some(tree) = &state.spatial_index {
            // Find all objects at this exact point
            for obj in tree.iter() {
                // Only match other vias
                if obj.range.obj_type != 2 { continue; }
                
                // Skip the original (will be added separately)
                if obj.range.id == range.id { continue; }
                // Skip already deleted
                if state.deleted_objects.contains_key(&obj.range.id) { continue; }
                
                // Check if this via is at the same location
                let other_x = (obj.range.bounds[0] + obj.range.bounds[2]) / 2.0;
                let other_y = (obj.range.bounds[1] + obj.range.bounds[3]) / 2.0;
                
                let dx = (via_x - other_x).abs();
                let dy = (via_y - other_y).abs();
                
                if dx < tolerance && dy < tolerance {
                    related_objects.push(obj.range.clone());
                    state.deleted_objects.insert(obj.range.id, obj.range.clone());
                }
            }
        }
        
        eprintln!("[LSP Server] Delete via at ({:.2}, {:.2}): 1 + {} related vias across layers", via_x, via_y, related_objects.len());
    } else {
        eprintln!("[LSP Server] Delete object id={}", range.id);
    }
    
    state.deleted_objects.insert(range.id, range);

    Response {
        id,
        result: Some(serde_json::json!({ 
            "status": "ok",
            "related_objects": related_objects
        })),
        error: None,
    }
}

/// Handle Undo request - restores the last deleted object
fn handle_undo(state: &mut ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    // The webview sends { object: ObjectRange } but we use our own stack
    let range: Option<ObjectRange> = params.and_then(|p| {
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    });

    // If webview sent an object, restore it directly (keeps webview and LSP in sync)
    if let Some(r) = range {
        eprintln!("[LSP Server] Undo delete for object id={}", r.id);
        state.deleted_objects.remove(&r.id);
        
        Response {
            id,
            result: Some(serde_json::json!({ "status": "ok", "restored_id": r.id })),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!({ "status": "ok", "message": "no object specified" })),
            error: None,
        }
    }
}

/// Handle Redo request - re-deletes an undone object
fn handle_redo(state: &mut ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    let range: Option<ObjectRange> = params.and_then(|p| {
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    });

    // If webview sent an object, delete it again (keeps webview and LSP in sync)
    if let Some(r) = range {
        eprintln!("[LSP Server] Redo delete for object id={}", r.id);
        state.deleted_objects.insert(r.id, r.clone());
        
        Response {
            id,
            result: Some(serde_json::json!({ "status": "ok", "deleted_id": r.id })),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!({ "status": "ok", "message": "no object specified" })),
            error: None,
        }
    }
}

/// Handle HighlightSelectedNets request - finds all shapes with the same net names as the selected shapes
fn handle_highlight_selected_nets(state: &ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct HighlightNetsParams {
        object_ids: Vec<u64>,
    }

    let params: HighlightNetsParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {object_ids: number[]}".to_string(),
                }),
            };
        }
    };

    eprintln!("[LSP Server] HighlightSelectedNets: {} object IDs provided", params.object_ids.len());
    log_to_file(&format!("HighlightSelectedNets: {} object IDs provided: {:?}", params.object_ids.len(), params.object_ids));

    if let Some(tree) = &state.spatial_index {
        // First, collect the net names from the selected objects
        let mut net_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        // Also collect bounds and IDs of selected objects that don't have nets, so we can search for overlapping objects
        // We keep the IDs so we can include the original selection in the highlight result
        let mut no_net_objects: Vec<(u64, [f32; 4])> = Vec::new();
        
        for obj in tree.iter() {
            if params.object_ids.contains(&obj.range.id) {
                log_to_file(&format!("  Selected object id={}, type={}, net={:?}, component={:?}", 
                    obj.range.id, obj.range.obj_type, obj.range.net_name, obj.range.component_ref));
                if let Some(ref net_name) = obj.range.net_name {
                    // Skip "No Net" or empty net names
                    if !net_name.is_empty() && net_name != "No Net" {
                        net_names.insert(net_name.clone());
                    } else {
                        // Object has empty/no net - save its id and bounds for searching
                        no_net_objects.push((obj.range.id, obj.range.bounds));
                    }
                } else {
                    // Object has no net - save its id and bounds for searching
                    no_net_objects.push((obj.range.id, obj.range.bounds));
                }
            }
        }
        
        // Track IDs of originally selected objects that should be included in highlight
        // (even though they don't have nets themselves)
        let mut include_original_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
        
        // For objects without nets, search for overlapping objects that DO have nets
        // This handles the case where user clicks on a paste/mask pad but expects copper behavior
        // We match by bounds - the F.Cu pad should have the same bounds as the F.Paste/F.Mask pad
        if !no_net_objects.is_empty() && net_names.is_empty() {
            log_to_file(&format!("  No nets found in selection, searching {} bounds for matching objects with nets", no_net_objects.len()));
            
            // Tolerance for matching bounds (objects at same location with same size)
            let tolerance = 0.01; // Small tolerance for floating point comparison
            
            for (orig_id, bounds) in &no_net_objects {
                // Find the center of the object
                let center_x = (bounds[0] + bounds[2]) / 2.0;
                let center_y = (bounds[1] + bounds[3]) / 2.0;
                let point = [center_x, center_y];
                
                let obj_width = bounds[2] - bounds[0];
                let obj_height = bounds[3] - bounds[1];
                
                log_to_file(&format!("    Searching at ({:.3}, {:.3}) for bounds matching [{:.3}, {:.3}, {:.3}, {:.3}] (size: {:.3} x {:.3})", 
                    center_x, center_y, bounds[0], bounds[1], bounds[2], bounds[3], obj_width, obj_height));
                
                // Search for objects at this point that have a net AND matching bounds
                for obj in tree.locate_all_at_point(&point) {
                    if let Some(ref net_name) = obj.range.net_name {
                        if !net_name.is_empty() && net_name != "No Net" {
                            // Check if bounds match (same shape on different layer)
                            let other_bounds = obj.range.bounds;
                            let other_width = other_bounds[2] - other_bounds[0];
                            let other_height = other_bounds[3] - other_bounds[1];
                            
                            // Check if widths and heights match within tolerance
                            let width_match = (obj_width - other_width).abs() < tolerance;
                            let height_match = (obj_height - other_height).abs() < tolerance;
                            // Also check position matches
                            let x_match = (bounds[0] - other_bounds[0]).abs() < tolerance && (bounds[2] - other_bounds[2]).abs() < tolerance;
                            let y_match = (bounds[1] - other_bounds[1]).abs() < tolerance && (bounds[3] - other_bounds[3]).abs() < tolerance;
                            
                            if width_match && height_match && x_match && y_match {
                                log_to_file(&format!("      MATCH: id={}, type={}, net={}, bounds=[{:.3}, {:.3}, {:.3}, {:.3}]", 
                                    obj.range.id, obj.range.obj_type, net_name, 
                                    other_bounds[0], other_bounds[1], other_bounds[2], other_bounds[3]));
                                net_names.insert(net_name.clone());
                                // Include the original no-net object in the highlight result
                                include_original_ids.insert(*orig_id);
                            } else {
                                log_to_file(&format!("      SKIP (bounds mismatch): id={}, type={}, net={}, bounds=[{:.3}, {:.3}, {:.3}, {:.3}]", 
                                    obj.range.id, obj.range.obj_type, net_name,
                                    other_bounds[0], other_bounds[1], other_bounds[2], other_bounds[3]));
                            }
                        }
                    }
                }
            }
        }
        
        log_to_file(&format!("Found {} unique net names: {:?}", net_names.len(), net_names));
        
        // Debug: show breakdown of all objects with each net name
        for net_name in &net_names {
            let mut pads = 0;
            let mut vias = 0;
            let mut polygons = 0;
            let mut polylines = 0;
            for obj in tree.iter() {
                if obj.range.net_name.as_ref() == Some(net_name) {
                    match obj.range.obj_type {
                        0 => polylines += 1,
                        1 => polygons += 1,
                        2 => vias += 1,
                        3 => pads += 1,
                        _ => {}
                    }
                }
            }
            log_to_file(&format!("  Net '{}': {} pads, {} vias, {} polygons, {} polylines", 
                net_name, pads, vias, polygons, polylines));
        }
        
        if net_names.is_empty() {
            return Response {
                id,
                result: Some(serde_json::json!({
                    "net_names": [],
                    "objects": []
                })),
                error: None,
            };
        }
        
        // Now find all objects with matching net names OR that are in the original selection set
        let mut matching_objects: Vec<ObjectRange> = tree.iter()
            .filter(|obj| {
                // Include if it has a matching net name
                if let Some(ref net_name) = obj.range.net_name {
                    if net_names.contains(net_name) {
                        return true;
                    }
                }
                // Also include original selected objects that triggered the fallback search
                include_original_ids.contains(&obj.range.id)
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        // For all pads in the result, also find overlapping mask/paste/silkscreen objects
        // This ensures when highlighting a net, ALL layers of each pad are highlighted (not just copper)
        let tolerance = 0.01;
        let mut stacked_layer_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
        
        // Collect bounds of all pads in the result
        let pad_bounds: Vec<[f32; 4]> = matching_objects.iter()
            .filter(|obj| obj.obj_type == 3) // Pads only
            .map(|obj| obj.bounds)
            .collect();
        
        // For each pad, find other objects at the same location with matching bounds (stacked layers)
        for bounds in &pad_bounds {
            let center_x = (bounds[0] + bounds[2]) / 2.0;
            let center_y = (bounds[1] + bounds[3]) / 2.0;
            let point = [center_x, center_y];
            let obj_width = bounds[2] - bounds[0];
            let obj_height = bounds[3] - bounds[1];
            
            for obj in tree.locate_all_at_point(&point) {
                // Skip if already in result
                if matching_objects.iter().any(|o| o.id == obj.range.id) {
                    continue;
                }
                
                // Check if bounds match (same shape on different layer - paste/mask/silkscreen)
                let other_bounds = obj.range.bounds;
                let other_width = other_bounds[2] - other_bounds[0];
                let other_height = other_bounds[3] - other_bounds[1];
                
                let width_match = (obj_width - other_width).abs() < tolerance;
                let height_match = (obj_height - other_height).abs() < tolerance;
                let x_match = (bounds[0] - other_bounds[0]).abs() < tolerance && (bounds[2] - other_bounds[2]).abs() < tolerance;
                let y_match = (bounds[1] - other_bounds[1]).abs() < tolerance && (bounds[3] - other_bounds[3]).abs() < tolerance;
                
                if width_match && height_match && x_match && y_match {
                    stacked_layer_ids.insert(obj.range.id);
                }
            }
        }
        
        // Add all stacked layer objects to the result
        if !stacked_layer_ids.is_empty() {
            log_to_file(&format!("Found {} additional stacked layer objects (mask/paste/silkscreen)", stacked_layer_ids.len()));
            for obj in tree.iter() {
                if stacked_layer_ids.contains(&obj.range.id) {
                    matching_objects.push(obj.range.clone());
                }
            }
        }
        
        // Debug: count by type
        let pads = matching_objects.iter().filter(|o| o.obj_type == 3).count();
        let vias = matching_objects.iter().filter(|o| o.obj_type == 2).count();
        let polygons = matching_objects.iter().filter(|o| o.obj_type == 1).count();
        let polylines = matching_objects.iter().filter(|o| o.obj_type == 0).count();
        log_to_file(&format!("Found {} objects with matching nets (including {} original + {} stacked layers): {} pads, {} vias, {} polygons, {} polylines", 
            matching_objects.len(), include_original_ids.len(), stacked_layer_ids.len(), pads, vias, polygons, polylines));
        
        let net_names_vec: Vec<String> = net_names.into_iter().collect();
        
        Response {
            id,
            result: Some(serde_json::json!({
                "net_names": net_names_vec,
                "objects": matching_objects
            })),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!({
                "net_names": [],
                "objects": []
            })),
            error: None,
        }
    }
}

/// Handle HighlightSelectedComponents request - finds all shapes with the same component refs as the selected shapes
fn handle_highlight_selected_components(state: &ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct HighlightComponentsParams {
        object_ids: Vec<u64>,
    }

    let params: HighlightComponentsParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {object_ids: number[]}".to_string(),
                }),
            };
        }
    };

    eprintln!("[LSP Server] HighlightSelectedComponents: {} object IDs provided", params.object_ids.len());

    if let Some(tree) = &state.spatial_index {
        // First, collect the component refs from the selected objects
        let mut component_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        for obj in tree.iter() {
            if params.object_ids.contains(&obj.range.id) {
                eprintln!("[LSP Server] Selected object id={}, type={}, net={:?}, component={:?}", 
                    obj.range.id, obj.range.obj_type, obj.range.net_name, obj.range.component_ref);
                if let Some(ref comp_ref) = obj.range.component_ref {
                    // Skip empty component refs
                    if !comp_ref.is_empty() {
                        component_refs.insert(comp_ref.clone());
                    }
                }
            }
        }
        
        eprintln!("[LSP Server] Found {} unique component refs: {:?}", component_refs.len(), component_refs);
        
        if component_refs.is_empty() {
            return Response {
                id,
                result: Some(serde_json::json!({
                    "component_refs": [],
                    "objects": []
                })),
                error: None,
            };
        }
        
        // Now find all objects with matching component refs
        let matching_objects: Vec<ObjectRange> = tree.iter()
            .filter(|obj| {
                if let Some(ref comp_ref) = obj.range.component_ref {
                    component_refs.contains(comp_ref)
                } else {
                    false
                }
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        eprintln!("[LSP Server] Found {} objects with matching components", matching_objects.len());
        
        let component_refs_vec: Vec<String> = component_refs.into_iter().collect();
        
        Response {
            id,
            result: Some(serde_json::json!({
                "component_refs": component_refs_vec,
                "objects": matching_objects
            })),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!({
                "component_refs": [],
                "objects": []
            })),
            error: None,
        }
    }
}

/// Handle QueryNetAtPoint request - returns the net name of the object at a given point
fn handle_query_net_at_point(
    state: &ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct QueryNetAtPointParams {
        x: f64,
        y: f64,
    }

    let params: QueryNetAtPointParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {x: number, y: number}".to_string(),
                }),
            };
        }
    };

    if let Some(tree) = &state.spatial_index {
        // Query R-tree for objects at this point
        let point = [params.x as f32, params.y as f32];
        
        // Collect all candidates at this point
        let mut candidates: Vec<&SelectableObject> = tree.locate_all_at_point(&point)
            .filter(|obj| {
                // Skip deleted objects
                if state.deleted_objects.contains_key(&obj.range.id) {
                    return false;
                }
                // Skip objects on hidden layers
                if state.hidden_layers.contains(&obj.range.layer_id) {
                    return false;
                }
                // Skip if point doesn't actually hit the object's geometry
                if !point_hits_object(params.x as f32, params.y as f32, &obj.range, &state.layers) {
                    return false;
                }
                true
            })
            .collect();
        
        // Sort by priority: pads (3) and vias (2) come first, then by layer order
        // This matches the rendering order where pads are drawn on top
        candidates.sort_by(|a, b| {
            // Priority: pad=3 > via=2 > polygon=1 > polyline=0
            let type_priority = |t: u8| match t {
                3 => 0, // Pad - highest priority
                2 => 1, // Via
                1 => 2, // Polygon
                _ => 3, // Polyline and others
            };
            type_priority(a.range.obj_type).cmp(&type_priority(b.range.obj_type))
        });
        
        // Return first object with a valid net name, including component_ref and pin_ref if available
        for obj in candidates {
            if let Some(ref net_name) = obj.range.net_name {
                if !net_name.is_empty() {
                    return Response {
                        id,
                        result: Some(serde_json::json!({
                            "net_name": net_name,
                            "component_ref": obj.range.component_ref,
                            "pin_ref": obj.range.pin_ref
                        })),
                        error: None,
                    };
                }
            }
        }
        
        // No net found at this point
        Response {
            id,
            result: Some(serde_json::json!({
                "net_name": null
            })),
            error: None,
        }
    } else {
        Response {
            id,
            result: Some(serde_json::json!({
                "net_name": null
            })),
            error: None,
        }
    }
}

/// Handle GetMemory request - returns current process memory usage
fn handle_get_memory(id: Option<serde_json::Value>) -> Response {
    let memory_bytes = get_process_memory_bytes();
    
    Response {
        id,
        result: Some(serde_json::json!({
            "memory_bytes": memory_bytes
        })),
        error: None,
    }
}

/// Handle Close request - clears all state to free memory when webview is closed
fn handle_close(state: &mut ServerState, id: Option<serde_json::Value>) -> Response {
    let old_memory = get_process_memory_bytes().unwrap_or(0);
    
    // Clear all state
    state.xml_file_path = None;
    state.xml_root = None;
    state.layers.clear();
    state.layer_colors.clear();
    state.modified_colors.clear();
    state.spatial_index = None;
    state.padstack_defs.clear();
    state.deleted_objects.clear();
    state.hidden_layers.clear();
    state.all_object_ranges.clear();
    state.drc_violations.clear();
    
    // Force a garbage collection hint by shrinking capacity
    state.layers.shrink_to_fit();
    state.layer_colors.shrink_to_fit();
    state.modified_colors.shrink_to_fit();
    state.padstack_defs.shrink_to_fit();
    state.deleted_objects.shrink_to_fit();
    state.all_object_ranges.shrink_to_fit();
    state.drc_violations.shrink_to_fit();
    
    let new_memory = get_process_memory_bytes().unwrap_or(0);
    eprintln!("[LSP Server] Close: freed {} MB", (old_memory as i64 - new_memory as i64) / 1024 / 1024);
    
    Response {
        id,
        result: Some(serde_json::json!({
            "freed_bytes": old_memory.saturating_sub(new_memory)
        })),
        error: None,
    }
}

/// Handle RunDRC request - runs Design Rule Check on all copper layers
fn handle_run_drc(state: &mut ServerState, id: Option<serde_json::Value>, params: Option<serde_json::Value>) -> Response {
    #[derive(Deserialize)]
    struct RunDRCParams {
        #[serde(default)]
        clearance_mm: Option<f32>,
    }

    let params: RunDRCParams = params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or(RunDRCParams { clearance_mm: None });

    if state.xml_file_path.is_none() {
        return Response {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
    }

    // Update design rules if custom clearance provided
    if let Some(clearance) = params.clearance_mm {
        state.design_rules.conductor_clearance_mm = clearance;
    }

    eprintln!("[LSP Server] Running DRC with clearance: {:.3}mm", state.design_rules.conductor_clearance_mm);
    
    let start = Instant::now();
    
    // Run full DRC
    let violations = if let Some(ref spatial_index) = state.spatial_index {
        run_full_drc(
            &state.layers,
            spatial_index,
            &state.design_rules,
        )
    } else {
        vec![]
    };
    
    let elapsed = start.elapsed();
    let violation_count = violations.len();
    
    eprintln!("[LSP Server] DRC completed in {:.2}ms: {} violations found", 
        elapsed.as_secs_f64() * 1000.0, violation_count);
    
    // Cache violations
    state.drc_violations = violations;

    Response {
        id,
        result: Some(serde_json::json!({
            "status": "ok",
            "violation_count": violation_count,
            "elapsed_ms": elapsed.as_secs_f64() * 1000.0
        })),
        error: None,
    }
}

/// Handle GetDRCViolations request - returns cached DRC violations
fn handle_get_drc_violations(state: &ServerState, id: Option<serde_json::Value>) -> Response {
    Response {
        id,
        result: Some(serde_json::to_value(&state.drc_violations).unwrap()),
        error: None,
    }
}

/// Handle RunDRCWithRegions request asynchronously - spawns DRC in background thread
fn handle_run_drc_with_regions_async(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>,
    tx: Option<Sender<DrcAsyncResult>>
) -> String {
    #[derive(Deserialize)]
    struct RunDRCParams {
        #[serde(default)]
        clearance_mm: Option<f32>,
    }

    let params: RunDRCParams = params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or(RunDRCParams { clearance_mm: None });

    if state.xml_file_path.is_none() {
        let response = Response {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: 2,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
        return serde_json::to_string(&response).unwrap();
    }

    let tx = match tx {
        Some(tx) => tx,
        None => {
            let response = Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 3,
                    message: "DRC channel not available".to_string(),
                }),
            };
            return serde_json::to_string(&response).unwrap();
        }
    };

    let clearance = params.clearance_mm.unwrap_or(state.design_rules.conductor_clearance_mm);
    
    // Clone data needed for background thread
    let layers = state.layers.clone();
    let spatial_index = state.spatial_index.clone();
    let design_rules = DesignRules { conductor_clearance_mm: clearance };

    eprintln!("[LSP Server] Starting async DRC with clearance: {:.3}mm", clearance);
    
    // Spawn DRC in background thread
    thread::spawn(move || {
        let start = Instant::now();
        
        let regions = if let Some(ref index) = spatial_index {
            run_full_drc_with_regions(&layers, index, &design_rules)
        } else {
            vec![]
        };
        
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        
        // Send result back to main thread
        let _ = tx.send(DrcAsyncResult { regions, elapsed_ms });
    });

    // Return immediately with "started" status
    let response = Response {
        id,
        result: Some(serde_json::json!({
            "status": "started",
            "message": "DRC running in background"
        })),
        error: None,
    };
    serde_json::to_string(&response).unwrap()
}

/// Handle GetDRCRegions request - returns cached DRC regions with triangle data
fn handle_get_drc_regions(state: &ServerState, id: Option<serde_json::Value>) -> Response {
    Response {
        id,
        result: Some(serde_json::to_value(&state.drc_regions).unwrap()),
        error: None,
    }
}

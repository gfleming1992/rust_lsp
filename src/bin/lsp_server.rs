use rust_extension::draw::geometry::{LayerJSON, LayerBinary, SelectableObject, ObjectRange};
use rust_extension::parse_xml::{parse_xml_file, XmlNode};
use rust_extension::draw::parsing::extract_and_generate_layers;
use rust_extension::serialize_xml::xml_node_to_file;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::time::Instant;
use std::collections::HashMap;
use rstar::RTree;

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
    layer_colors: HashMap<String, [f32; 4]>, // layer_id -> RGBA
    spatial_index: Option<RTree<SelectableObject>>,
    // Undo/Redo stacks for deleted objects
    deleted_objects: HashMap<u64, ObjectRange>, // Currently deleted objects (id -> ObjectRange)
    // Hidden layers (layer visibility)
    hidden_layers: std::collections::HashSet<String>, // layer_id -> hidden
}

impl ServerState {
    fn new() -> Self {
        Self {
            xml_file_path: None,
            xml_root: None,
            layers: Vec::new(),
            layer_colors: HashMap::new(),
            spatial_index: None,
            deleted_objects: HashMap::new(),
            hidden_layers: std::collections::HashSet::new(),
        }
    }
}

fn main() {
    eprintln!("[LSP Server] Starting IPC-2581 LSP server...");
    let mut state = ServerState::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
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

        eprintln!("[LSP Server] Received method: {}", request.method);

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
            "QueryNetAtPoint" => serde_json::to_string(&handle_query_net_at_point(&state, request.id, request.params)).unwrap(),
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
    
    // Build spatial index
    let start_index = Instant::now();
    let selectable_objects: Vec<SelectableObject> = object_ranges.into_iter()
        .map(SelectableObject::new)
        .collect();
    let spatial_index = RTree::bulk_load(selectable_objects);
    eprintln!("[LSP Server] Spatial Index build time: {:.2?}", start_index.elapsed());
    
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
    state.xml_root = Some(root);
    state.layers = layers;
    state.layer_colors = layer_colors;
    state.spatial_index = Some(spatial_index);

    eprintln!("[LSP Server] File loaded successfully");

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

    if state.xml_root.is_none() {
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

    // Update in-memory color map with prefixed key
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

    if state.xml_root.is_none() || state.xml_file_path.is_none() {
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

    // Clone root for modification
    let mut root_clone = state.xml_root.as_ref().unwrap().clone();
    
    // Update DictionaryColor in the XML tree
    update_dictionary_colors(&mut root_clone, &state.layer_colors);
    
    // Remove deleted objects from XML
    if !state.deleted_objects.is_empty() {
        let removed_count = remove_deleted_objects_from_xml(&mut root_clone, &state.deleted_objects, &state.layers);
        eprintln!("[LSP Server] Removed {} objects from XML", removed_count);
    }

    // Serialize to file
    match xml_node_to_file(&root_clone, &output_path) {
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

/// Update DictionaryColor in XML tree with current layer colors
fn update_dictionary_colors(root: &mut XmlNode, layer_colors: &HashMap<String, [f32; 4]>) {
    // Find or create Content node
    let content = if let Some(content) = root.children.iter_mut().find(|n| n.name == "Content") {
        content
    } else {
        // Insert Content after LogisticHeader/HistoryRecord if they exist, or at beginning
        let insert_pos = root.children.iter().position(|n| {
            n.name != "LogisticHeader" && n.name != "HistoryRecord"
        }).unwrap_or(0);
        
        root.children.insert(insert_pos, XmlNode {
            name: "Content".to_string(),
            attributes: indexmap::IndexMap::new(),
            children: Vec::new(),
            text_content: String::new(),
        });
        
        root.children.get_mut(insert_pos).unwrap()
    };
    
    // Find or create DictionaryColor
    let dict_color = if let Some(dict) = content.children.iter_mut().find(|n| n.name == "DictionaryColor") {
        // Clear existing entries
        dict.children.clear();
        dict
    } else {
        // Add DictionaryColor at start of Content
        content.children.insert(0, XmlNode {
            name: "DictionaryColor".to_string(),
            attributes: indexmap::IndexMap::new(),
            children: Vec::new(),
            text_content: String::new(),
        });
        
        content.children.get_mut(0).unwrap()
    };
    
    // Add EntryColor for each layer color
    for (layer_id, color) in layer_colors {
        let mut entry_attrs = indexmap::IndexMap::new();
        entry_attrs.insert("id".to_string(), layer_id.clone());
        
        let r = (color[0] * 255.0).round() as u8;
        let g = (color[1] * 255.0).round() as u8;
        let b = (color[2] * 255.0).round() as u8;
        
        let mut color_attrs = indexmap::IndexMap::new();
        color_attrs.insert("r".to_string(), r.to_string());
        color_attrs.insert("g".to_string(), g.to_string());
        color_attrs.insert("b".to_string(), b.to_string());
        
        let entry = XmlNode {
            name: "EntryColor".to_string(),
            attributes: entry_attrs,
            children: vec![XmlNode {
                name: "Color".to_string(),
                attributes: color_attrs,
                children: Vec::new(),
                text_content: String::new(),
            }],
            text_content: String::new(),
        };
        
        dict_color.children.push(entry);
    }
}

/// Remove deleted objects from XML tree
/// Returns the number of objects removed
fn remove_deleted_objects_from_xml(
    root: &mut XmlNode,
    deleted_objects: &HashMap<u64, ObjectRange>,
    _layers: &[LayerJSON],
) -> usize {
    // Build a map of layer_id -> set of deleted object indices by type
    // ID format: (layer_index << 40) | (obj_type << 36) | object_index
    let mut deleted_by_layer: HashMap<String, HashMap<u8, std::collections::HashSet<usize>>> = HashMap::new();
    
    for (id, range) in deleted_objects {
        let obj_index = (*id & 0xFFFFFFFFF) as usize; // Lower 36 bits
        let obj_type = range.obj_type;
        
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
    fn process_node(
        node: &mut XmlNode,
        deleted_by_layer: &HashMap<String, HashMap<u8, std::collections::HashSet<usize>>>,
        current_layer: Option<&str>,
        counters: &mut HashMap<String, HashMap<u8, usize>>, // layer -> type -> count
        removed: &mut usize,
    ) {
        // Check if this is a LayerFeature - updates current layer context
        let layer_ref = if node.name == "LayerFeature" {
            node.attributes.get("layerRef").map(|s| s.as_str())
        } else {
            current_layer
        };
        
        // Check if this node should be removed
        let should_remove = |child: &XmlNode, layer: Option<&str>, counters: &mut HashMap<String, HashMap<u8, usize>>| -> bool {
            let layer_id = match layer {
                Some(l) => l,
                None => return false,
            };
            
            let deleted_for_layer = match deleted_by_layer.get(layer_id) {
                Some(d) => d,
                None => return false,
            };
            
            // Determine object type and check if this index is deleted
            let obj_type = match child.name.as_str() {
                "Polyline" | "Line" => 0u8,
                "Polygon" => 1u8,
                "Pad" => {
                    // Check if it's a via (padUsage="VIA") or regular pad
                    if child.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA") {
                        2u8 // Via
                    } else {
                        3u8 // Pad
                    }
                }
                _ => return false,
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
            if let Some(deleted_indices) = deleted_for_layer.get(&obj_type) {
                if deleted_indices.contains(&current_idx) {
                    return true;
                }
            }
            
            false
        };
        
        // Process children - need to remove some and recurse into others
        let mut i = 0;
        while i < node.children.len() {
            let child = &node.children[i];
            
            if should_remove(child, layer_ref, counters) {
                node.children.remove(i);
                *removed += 1;
                // Don't increment i, the next element is now at position i
            } else {
                // Recurse into this child
                let child_mut = &mut node.children[i];
                process_node(child_mut, deleted_by_layer, layer_ref, counters, removed);
                i += 1;
            }
        }
    }
    
    let mut counters: HashMap<String, HashMap<u8, usize>> = HashMap::new();
    process_node(root, &deleted_by_layer, None, &mut counters, &mut total_removed);
    
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
    let lod0 = &lods[0];
    
    // Handle instanced geometry (vias, pads)
    if range.obj_type == 2 || range.obj_type == 3 {
        // For instanced geometry, check if point is within the instance's bounds
        // The instance position is stored in instance_data
        if let (Some(inst_data), Some(inst_idx)) = (&lod0.instance_data, range.instance_index) {
            let floats_per_instance = if range.obj_type == 3 { 3 } else { 3 }; // x, y, packed_rot_vis
            let base = (inst_idx as usize) * floats_per_instance;
            if base + 1 < inst_data.len() {
                let inst_x = inst_data[base];
                let inst_y = inst_data[base + 1];
                
                // Check triangles of the base shape, offset by instance position
                if let Some(ref indices) = lod0.index_data {
                    for tri in indices.chunks(3) {
                        if tri.len() < 3 { continue; }
                        let i0 = tri[0] as usize * 2;
                        let i1 = tri[1] as usize * 2;
                        let i2 = tri[2] as usize * 2;
                        
                        if i2 + 1 < lod0.vertex_data.len() {
                            let x0 = lod0.vertex_data[i0] + inst_x;
                            let y0 = lod0.vertex_data[i0 + 1] + inst_y;
                            let x1 = lod0.vertex_data[i1] + inst_x;
                            let y1 = lod0.vertex_data[i1 + 1] + inst_y;
                            let x2 = lod0.vertex_data[i2] + inst_x;
                            let y2 = lod0.vertex_data[i2 + 1] + inst_y;
                            
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
        let results: Vec<ObjectRange> = candidates.iter()
            .filter(|obj| point_hits_object(params.x, params.y, &obj.range, &state.layers))
            .map(|obj| obj.range.clone())
            .collect();
        
        eprintln!("[LSP Server] Select: {} AABB candidates -> {} precise hits", candidates.len(), results.len());
            
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
        let results: Vec<ObjectRange> = tree.locate_in_envelope_intersecting(&envelope)
            .map(|obj| obj.range.clone())
            .collect();
        
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

    eprintln!("[LSP Server] Delete object id={}", range.id);
    state.deleted_objects.insert(range.id, range);

    Response {
        id,
        result: Some(serde_json::json!({ "status": "ok" })),
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

    if let Some(tree) = &state.spatial_index {
        // First, collect the net names from the selected objects
        let mut net_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        for obj in tree.iter() {
            if params.object_ids.contains(&obj.range.id) {
                if let Some(ref net_name) = obj.range.net_name {
                    // Skip "No Net" or empty net names
                    if !net_name.is_empty() && net_name != "No Net" {
                        net_names.insert(net_name.clone());
                    }
                }
            }
        }
        
        eprintln!("[LSP Server] Found {} unique net names: {:?}", net_names.len(), net_names);
        
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
        
        // Now find all objects with matching net names
        let matching_objects: Vec<ObjectRange> = tree.iter()
            .filter(|obj| {
                if let Some(ref net_name) = obj.range.net_name {
                    net_names.contains(net_name)
                } else {
                    false
                }
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        eprintln!("[LSP Server] Found {} objects with matching nets", matching_objects.len());
        
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
        
        // Find all objects at this point, filter by precise geometry, return first with net name
        for obj in tree.locate_all_at_point(&point) {
            // Skip deleted objects
            if state.deleted_objects.contains_key(&obj.range.id) {
                continue;
            }
            
            // Skip objects on hidden layers
            if state.hidden_layers.contains(&obj.range.layer_id) {
                continue;
            }
            
            // Skip if point doesn't actually hit the object's geometry
            if !point_hits_object(params.x as f32, params.y as f32, &obj.range, &state.layers) {
                continue;
            }
            
            if let Some(ref net_name) = obj.range.net_name {
                if !net_name.is_empty() {
                    return Response {
                        id,
                        result: Some(serde_json::json!({
                            "net_name": net_name
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

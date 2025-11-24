use rust_extension::draw::geometry::{LayerJSON, LayerBinary};
use rust_extension::parse_xml::{parse_xml_file, XmlNode};
use rust_extension::draw::parsing::extract_and_generate_layers;
use rust_extension::serialize_xml::xml_node_to_file;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::time::Instant;
use std::collections::HashMap;

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
}

impl ServerState {
    fn new() -> Self {
        Self {
            xml_file_path: None,
            xml_root: None,
            layers: Vec::new(),
            layer_colors: HashMap::new(),
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

        eprintln!("[LSP Server] Received line: {}", line);

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
            "Save" => serde_json::to_string(&handle_save(&mut state, request.id, request.params)).unwrap(),
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
    let layers = match extract_and_generate_layers(&root) {
        Ok(layers) => layers,
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
    eprintln!("[LSP Server] Total Load time: {:.2?}", start_total.elapsed());

    eprintln!("[LSP Server] Generated {} layers", layers.len());

    // Parse DictionaryColor from XML to get layer colors
    let layer_colors = parse_dictionary_colors(&root);
    eprintln!("[LSP Server] Parsed {} layer colors from DictionaryColor", layer_colors.len());

    // Debug: Print all layer IDs and colors
    eprintln!("[LSP Server] Available layer IDs:");
    for layer in &layers {
        eprintln!("  - '{}' (current color: {:?})", layer.layer_id, layer.default_color);
    }
    
    eprintln!("[LSP Server] Dictionary colors:");
    for (key, color) in &layer_colors {
        eprintln!("  - '{}': {:?}", key, color);
    }

    // Apply DictionaryColor values to layers
    let mut layers = layers;
    for layer in &mut layers {
        // Check both with and without LAYER_COLOR_ prefix
        let color_key = format!("LAYER_COLOR_{}", layer.layer_id);
        if let Some(&color) = layer_colors.get(&color_key) {
            eprintln!("[LSP Server] Applying color from DictionaryColor to layer '{}': {:?}", layer.layer_id, color);
            layer.default_color = color;
        } else if let Some(&color) = layer_colors.get(&layer.layer_id) {
            eprintln!("[LSP Server] Applying color from DictionaryColor to layer '{}': {:?}", layer.layer_id, color);
            layer.default_color = color;
        } else {
            eprintln!("[LSP Server] No DictionaryColor found for layer '{}'", layer.layer_id);
        }
    }

    state.xml_file_path = Some(params.file_path.clone());
    state.xml_root = Some(root);
    state.layers = layers;
    state.layer_colors = layer_colors;

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

    // Clone root for modification
    let mut root_clone = state.xml_root.as_ref().unwrap().clone();
    
    // Update DictionaryColor in the XML tree
    update_dictionary_colors(&mut root_clone, &state.layer_colors);

    // Serialize to file
    match xml_node_to_file(&root_clone, &output_path) {
        Ok(_) => {
            eprintln!("[LSP Server] File saved successfully");
            Response {
                id,
                result: Some(serde_json::json!({
                    "status": "ok",
                    "file_path": output_path
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

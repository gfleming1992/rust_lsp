use rust_extension::draw::geometry::LayerJSON;
use rust_extension::parse_xml::parse_xml_file;
use rust_extension::draw::parsing::extract_and_generate_layers;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};

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

/// In-memory state: DOM and layer cache
struct ServerState {
    xml_file_path: Option<String>,
    layers: Vec<LayerJSON>,
    layer_cache: HashMap<String, LayerJSON>,
}

impl ServerState {
    fn new() -> Self {
        Self {
            xml_file_path: None,
            layers: Vec::new(),
            layer_cache: HashMap::new(),
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

        let response = match request.method.as_str() {
            "Load" => handle_load(&mut state, request.id, request.params),
            "GetLayers" => handle_get_layers(&state, request.id),
            "GetTessellation" => handle_get_tessellation(&mut state, request.id, request.params),
            _ => Response {
                id: request.id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32601,
                    message: format!("Method not found: {}", request.method),
                }),
            },
        };

        let response_json = serde_json::to_string(&response).unwrap();
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

    // Parse XML file
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

    // Extract and generate layer geometries
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

    eprintln!("[LSP Server] Generated {} layers", layers.len());

    state.xml_file_path = Some(params.file_path.clone());
    state.layers = layers;
    state.layer_cache.clear();

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

fn handle_get_tessellation(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct TessellationParams {
        layer_id: String,
    }

    let params: TessellationParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: -32602,
                    message: "Invalid params: expected {layer_id: string}".to_string(),
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

    eprintln!("[LSP Server] Tessellating layer: {}", params.layer_id);

    // Check cache first
    if let Some(cached) = state.layer_cache.get(&params.layer_id) {
        eprintln!("[LSP Server] Returning cached tessellation for layer: {}", params.layer_id);
        return Response {
            id,
            result: Some(serde_json::to_value(cached).unwrap()),
            error: None,
        };
    }

    // Find the layer in the generated layers
    let layer = state.layers.iter().find(|l| l.layer_id == params.layer_id);

    match layer {
        Some(layer_json) => {
            // Cache the result (clone since layer_json is a reference)
            let layer_clone = layer_json.clone();
            state.layer_cache.insert(params.layer_id.clone(), layer_clone.clone());

            eprintln!("[LSP Server] Returning tessellation for layer: {}", params.layer_id);

            Response {
                id,
                result: Some(serde_json::to_value(&layer_clone).unwrap()),
                error: None,
            }
        }
        None => {
            Response {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: 3,
                    message: format!("Layer not found: {}", params.layer_id),
                }),
            }
        }
    }
}

use rust_extension::draw::geometry::{LayerJSON, LayerBinary};
use rust_extension::parse_xml::parse_xml_file;
use rust_extension::draw::parsing::extract_and_generate_layers;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::time::Instant;

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

/// In-memory state: DOM and layer cache
struct ServerState {
    xml_file_path: Option<String>,
    layers: Vec<LayerJSON>,
    // layer_cache removed as we don't need it with zero-copy serialization
}

impl ServerState {
    fn new() -> Self {
        Self {
            xml_file_path: None,
            layers: Vec::new(),
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

    state.xml_file_path = Some(params.file_path.clone());
    state.layers = layers;

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

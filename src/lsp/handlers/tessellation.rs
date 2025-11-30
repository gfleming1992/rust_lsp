//! Tessellation handlers: GetTessellation (JSON and Binary)

use crate::lsp::protocol::{TypedResponse, ErrorResponse, error_codes};
use crate::lsp::state::ServerState;
use crate::draw::geometry::LayerBinary;
use serde::Deserialize;
use std::time::Instant;

/// Handle GetTessellation request - returns layer geometry as JSON
pub fn handle_get_tessellation_json(
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
                    code: error_codes::INVALID_PARAMS,
                    message: "Invalid params: expected {layer_id: string}".to_string(),
                }),
            };
            return serde_json::to_string(&response).unwrap();
        }
    };

    if !state.is_file_loaded() {
        let response = TypedResponse::<()> {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: error_codes::NO_FILE_LOADED,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
        return serde_json::to_string(&response).unwrap();
    }

    eprintln!("[LSP Server] Tessellating layer: {}", params.layer_id);

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
            eprintln!("[LSP Server] Serialization time for layer {}: {:.2?}", 
                params.layer_id, start_serialize.elapsed());
            eprintln!("[LSP Server] Returning tessellation for layer: {}", params.layer_id);

            result_string
        }
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: error_codes::LAYER_NOT_FOUND,
                    message: format!("Layer not found: {}", params.layer_id),
                }),
            };
            serde_json::to_string(&response).unwrap()
        }
    }
}

/// Handle GetTessellationBinary request - returns binary-encoded geometry
pub fn handle_get_tessellation_binary(
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
                    code: error_codes::INVALID_PARAMS,
                    message: "Invalid params: expected {layer_id: string}".to_string(),
                }),
            };
            return serde_json::to_string(&response).unwrap();
        }
    };

    if !state.is_file_loaded() {
        let response = TypedResponse::<()> {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: error_codes::NO_FILE_LOADED,
                message: "No file loaded. Call Load first.".to_string(),
            }),
        };
        return serde_json::to_string(&response).unwrap();
    }

    eprintln!("[LSP Server] Binary tessellating layer: {}", params.layer_id);

    let layer = state.layers.iter().find(|l| l.layer_id == params.layer_id);

    match layer {
        Some(layer_json) => {
            let start_serialize = Instant::now();
            
            // Convert to binary format
            let layer_binary = LayerBinary::from_layer_json(layer_json);
            let binary_data = layer_binary.to_bytes();
            
            eprintln!("[LSP Server] Binary serialization time for layer {}: {:.2?}, size: {} bytes", 
                params.layer_id, start_serialize.elapsed(), binary_data.len());

            // Return special binary response format
            let id_str = match &id {
                Some(serde_json::Value::Number(n)) => n.to_string(),
                Some(serde_json::Value::String(s)) => s.clone(),
                _ => "null".to_string(),
            };
            
            use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
            let encoded_data = BASE64.encode(&binary_data);
            
            format!("BINARY:{}:{}", id_str, encoded_data)
        }
        None => {
            let response = TypedResponse::<()> {
                id,
                result: None,
                error: Some(ErrorResponse {
                    code: error_codes::LAYER_NOT_FOUND,
                    message: format!("Layer not found: {}", params.layer_id),
                }),
            };
            serde_json::to_string(&response).unwrap()
        }
    }
}

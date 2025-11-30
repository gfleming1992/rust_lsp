//! Layer operations: GetLayers, UpdateLayerColor, SetLayerVisibility

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use serde::Deserialize;

/// Handle GetLayers request - returns list of layer IDs
pub fn handle_get_layers(state: &ServerState, id: Option<serde_json::Value>) -> Response {
    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    let layer_ids: Vec<String> = state.layers.iter()
        .map(|l| l.layer_id.clone())
        .collect();

    Response::success(id, serde_json::to_value(layer_ids).unwrap())
}

/// Handle UpdateLayerColor request - updates layer color in memory
pub fn handle_update_layer_color(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct UpdateColorParams {
        layer_id: String,
        color: [f32; 4],
    }

    let params: UpdateColorParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {layer_id: string, color: [f32; 4]}".to_string());
        }
    };

    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    eprintln!("[LSP Server] Updating color for layer {}: {:?}", params.layer_id, params.color);

    // Ensure we use the LAYER_COLOR_ prefix
    let color_key = if params.layer_id.starts_with("LAYER_COLOR_") {
        params.layer_id.clone()
    } else {
        format!("LAYER_COLOR_{}", params.layer_id)
    };

    // Store in modified_colors for save
    state.modified_colors.insert(color_key.clone(), params.color);
    
    // Update layer_colors for UI
    state.layer_colors.insert(color_key, params.color);

    // Update layer's default_color
    if let Some(layer) = state.layers.iter_mut().find(|l| l.layer_id == params.layer_id) {
        layer.default_color = params.color;
    }

    Response::success(id, serde_json::json!({"status": "ok"}))
}

/// Handle SetLayerVisibility request - updates layer visibility state
pub fn handle_set_layer_visibility(
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
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {layer_id: string, visible: bool}".to_string());
        }
    };

    eprintln!("[LSP Server] Setting layer {} visibility to {}", params.layer_id, params.visible);

    if params.visible {
        state.hidden_layers.remove(&params.layer_id);
    } else {
        state.hidden_layers.insert(params.layer_id.clone());
    }

    Response::success(id, serde_json::json!({"status": "ok"}))
}

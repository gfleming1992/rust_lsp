//! Query handlers: QueryNetAtPoint, GetMemory

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::lsp::util::get_process_memory_bytes;
use serde::Deserialize;

/// Handle QueryNetAtPoint request - finds net(s) at a given point
pub fn handle_query_net_at_point(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct QueryNetParams {
        x: f32,
        y: f32,
        #[serde(default)]
        radius: Option<f32>,
    }

    let params: QueryNetParams = match params {
        Some(p) => serde_json::from_value(p).unwrap_or_else(|_| QueryNetParams {
            x: 0.0, y: 0.0, radius: None
        }),
        None => QueryNetParams { x: 0.0, y: 0.0, radius: None }
    };

    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    let radius = params.radius.unwrap_or(0.5);
    
    // Collect nets from objects near the point
    let mut nets: Vec<String> = Vec::new();
    
    if let Some(ref spatial_index) = state.spatial_index {
        use rstar::AABB;
        let query_rect = AABB::from_corners(
            [params.x - radius, params.y - radius],
            [params.x + radius, params.y + radius],
        );
        
        for obj in spatial_index.locate_in_envelope(&query_rect) {
            if let Some(ref net) = obj.range.net_name {
                if !nets.contains(net) {
                    nets.push(net.clone());
                }
            }
        }
    }

    Response::success(id, serde_json::json!({
        "x": params.x,
        "y": params.y,
        "radius": radius,
        "nets": nets
    }))
}

/// Handle GetMemory request - returns current process memory usage
pub fn handle_get_memory(id: Option<serde_json::Value>) -> Response {
    let memory_bytes = get_process_memory_bytes();
    let memory_mb = memory_bytes.map(|b| b as f64 / 1024.0 / 1024.0);
    Response::success(id, serde_json::json!({
        "memory_bytes": memory_bytes,
        "memory_mb": memory_mb
    }))
}

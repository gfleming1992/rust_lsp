//! Query handlers: QueryNetAtPoint, GetMemory

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::lsp::util::get_process_memory_bytes;
use crate::lsp::handlers::selection::find_objects_at_point;
use serde::Deserialize;

/// Handle QueryNetAtPoint request - finds net/component/pin at a given point
pub fn handle_query_net_at_point(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct QueryNetParams {
        x: f32,
        y: f32,
    }

    let params: QueryNetParams = match params {
        Some(p) => serde_json::from_value(p).unwrap_or_else(|_| QueryNetParams {
            x: 0.0, y: 0.0
        }),
        None => QueryNetParams { x: 0.0, y: 0.0 }
    };

    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    // Use shared helper to find objects (already sorted by priority)
    let objects = find_objects_at_point(state, params.x, params.y);
    
    // Extract first net/component/pin from the prioritized results
    let mut net_name: Option<String> = None;
    let mut component_ref: Option<String> = None;
    let mut pin_ref: Option<String> = None;
    
    for obj in &objects {
        if net_name.is_none() { net_name = obj.net_name.clone(); }
        if component_ref.is_none() { component_ref = obj.component_ref.clone(); }
        if pin_ref.is_none() { pin_ref = obj.pin_ref.clone(); }
        if net_name.is_some() && component_ref.is_some() && pin_ref.is_some() {
            break;
        }
    }

    Response::success(id, serde_json::json!({
        "net_name": net_name,
        "component_ref": component_ref,
        "pin_ref": pin_ref
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

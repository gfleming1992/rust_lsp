//! Query handlers: QueryNetAtPoint, GetMemory

use crate::draw::drc::is_copper_layer;
use crate::lsp::protocol::Response;
use crate::lsp::state::ServerState;
use crate::lsp::util::{get_process_memory_bytes, parse_params, require_file_loaded};
use crate::lsp::handlers::selection::find_objects_at_point;
use serde::Deserialize;

/// Handle QueryNetAtPoint request - finds net/component/pin at a given point
/// Only considers objects on copper layers for tooltip display.
pub fn handle_query_net_at_point(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params { x: f32, y: f32 }

    let p: Params = match parse_params(id.clone(), params, "{x, y}") {
        Ok(p) => p,
        Err(e) => return e,
    };
    
    if let Err(e) = require_file_loaded(state, id.clone()) {
        return e;
    }

    // Build a set of copper layer IDs for filtering
    let copper_layers: std::collections::HashSet<&str> = state.layers.iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.as_str())
        .collect();

    // Use shared helper to find objects (already sorted by priority)
    // only_visible=true ensures hidden layers are excluded from tooltip
    let objects = find_objects_at_point(state, p.x, p.y, true);
    
    // Extract first net/component/pin from copper layers only
    let mut net_name: Option<String> = None;
    let mut component_ref: Option<String> = None;
    let mut pin_ref: Option<String> = None;
    
    for obj in &objects {
        // Skip non-copper layers for tooltip
        if !copper_layers.contains(obj.layer_id.as_str()) {
            continue;
        }
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

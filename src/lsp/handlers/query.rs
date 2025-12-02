//! Query handlers: QueryNetAtPoint, GetMemory

use crate::draw::drc::is_copper_layer;
use crate::lsp::protocol::Response;
use crate::lsp::state::ServerState;
use crate::lsp::util::{get_process_memory_bytes, parse_params, require_file_loaded};
use crate::lsp::handlers::selection::find_objects_at_point;
use serde::Deserialize;

/// Handle QueryNetAtPoint request - finds net/component/pin at a given point
/// Returns info for the same object that Select would return (topmost by layer order).
/// If that object is a non-copper pad, looks for the corresponding copper pad's net info.
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

    // Build a set of copper layer IDs
    let copper_layers: std::collections::HashSet<&str> = state.layers.iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.as_str())
        .collect();

    // Use shared helper to find objects (already sorted by priority - same as Select)
    let objects = find_objects_at_point(state, p.x, p.y, true);
    
    if objects.is_empty() {
        return Response::success(id, serde_json::json!({
            "net_name": null,
            "component_ref": null,
            "pin_ref": null
        }));
    }
    
    // Get the topmost object (same as what Select would return)
    let top_obj = &objects[0];
    
    let mut net_name: Option<String> = None;
    let mut component_ref: Option<String> = None;
    let mut pin_ref: Option<String> = None;
    
    // Check if topmost object is a pad/via
    let is_pad_or_via = top_obj.obj_type == 2 || top_obj.obj_type == 3;
    let is_on_copper = copper_layers.contains(top_obj.layer_id.as_str());
    
    if is_pad_or_via {
        if is_on_copper {
            // Copper pad/via - use its info directly
            net_name = top_obj.net_name.clone();
            component_ref = top_obj.component_ref.clone();
            pin_ref = top_obj.pin_ref.clone();
        } else {
            // Non-copper pad (F.Mask, F.SolderPad, etc.) - find matching copper pad
            // Look for a copper pad at the same location
            for obj in &objects {
                if (obj.obj_type == 2 || obj.obj_type == 3) && copper_layers.contains(obj.layer_id.as_str()) {
                    net_name = obj.net_name.clone();
                    component_ref = obj.component_ref.clone();
                    pin_ref = obj.pin_ref.clone();
                    break;
                }
            }
        }
    } else if is_on_copper {
        // Copper polygon/polyline (e.g., GND plane) - use its info
        net_name = top_obj.net_name.clone();
        component_ref = top_obj.component_ref.clone();
        pin_ref = top_obj.pin_ref.clone();
    }
    // Non-copper, non-pad objects (like silkscreen) - no net info to show

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

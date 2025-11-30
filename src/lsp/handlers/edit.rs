//! Edit handlers: Delete, Undo, Redo

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::draw::geometry::ObjectRange;

/// Handle Delete request - marks an object as deleted
pub fn handle_delete(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    let range: ObjectRange = match params.and_then(|p| {
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    }) {
        Some(r) => r,
        None => {
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {object: ObjectRange}".to_string());
        }
    };

    let mut related_objects: Vec<ObjectRange> = Vec::new();
    
    // For vias, find and delete all vias at the same location
    if range.obj_type == 2 {
        let via_x = (range.bounds[0] + range.bounds[2]) / 2.0;
        let via_y = (range.bounds[1] + range.bounds[3]) / 2.0;
        let tolerance = 0.1;
        
        if let Some(tree) = &state.spatial_index {
            for obj in tree.iter() {
                if obj.range.obj_type != 2 { continue; }
                if obj.range.id == range.id { continue; }
                if state.deleted_objects.contains_key(&obj.range.id) { continue; }
                
                let other_x = (obj.range.bounds[0] + obj.range.bounds[2]) / 2.0;
                let other_y = (obj.range.bounds[1] + obj.range.bounds[3]) / 2.0;
                
                let dx = (via_x - other_x).abs();
                let dy = (via_y - other_y).abs();
                
                if dx < tolerance && dy < tolerance {
                    related_objects.push(obj.range.clone());
                    state.deleted_objects.insert(obj.range.id, obj.range.clone());
                }
            }
        }
        
        eprintln!("[LSP Server] Delete via at ({:.2}, {:.2}): 1 + {} related vias", 
            via_x, via_y, related_objects.len());
    } else {
        eprintln!("[LSP Server] Delete object id={}", range.id);
    }
    
    // Record modified regions for incremental DRC
    state.record_modified_region(&range);
    for related in &related_objects {
        state.record_modified_region(related);
    }
    
    state.deleted_objects.insert(range.id, range);

    Response::success(id, serde_json::json!({ 
        "status": "ok",
        "related_objects": related_objects
    }))
}

/// Handle Undo request - restores a deleted object
pub fn handle_undo(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    let range: Option<ObjectRange> = params.and_then(|p| {
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    });

    if let Some(r) = range {
        eprintln!("[LSP Server] Undo delete for object id={}", r.id);
        
        state.record_modified_region(&r);
        state.deleted_objects.remove(&r.id);
        
        Response::success(id, serde_json::json!({ 
            "status": "ok", 
            "restored_id": r.id 
        }))
    } else {
        Response::success(id, serde_json::json!({ 
            "status": "ok", 
            "message": "no object specified" 
        }))
    }
}

/// Handle Redo request - re-deletes an undone object
pub fn handle_redo(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    let range: Option<ObjectRange> = params.and_then(|p| {
        if let serde_json::Value::Object(map) = p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    });

    if let Some(r) = range {
        eprintln!("[LSP Server] Redo delete for object id={}", r.id);
        
        state.record_modified_region(&r);
        state.deleted_objects.insert(r.id, r.clone());
        
        Response::success(id, serde_json::json!({ 
            "status": "ok", 
            "deleted_id": r.id 
        }))
    } else {
        Response::success(id, serde_json::json!({ 
            "status": "ok", 
            "message": "no object specified" 
        }))
    }
}

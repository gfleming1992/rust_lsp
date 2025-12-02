//! Edit handlers: Delete, Undo, Redo, MoveObjects

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::{ServerState, ObjectMove};
use crate::lsp::util::parse_params;
use crate::draw::geometry::ObjectRange;
use serde::Deserialize;

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

/// Handle MoveObjects request - records a move operation for multiple objects
pub fn handle_move_objects(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params {
        object_ids: Vec<u64>,
        delta_x: f32,
        delta_y: f32,
    }
    
    let p: Params = match parse_params(id.clone(), params, "{object_ids, delta_x, delta_y}") {
        Ok(p) => p,
        Err(e) => return e,
    };
    
    eprintln!("[LSP Server] MoveObjects: {} objects by ({:.3}, {:.3})", 
        p.object_ids.len(), p.delta_x, p.delta_y);
    
    // Update all_object_ranges bounds for the moved objects
    for range in &mut state.all_object_ranges {
        if p.object_ids.contains(&range.id) {
            // Update bounds
            range.bounds[0] += p.delta_x; // min_x
            range.bounds[1] += p.delta_y; // min_y
            range.bounds[2] += p.delta_x; // max_x
            range.bounds[3] += p.delta_y; // max_y
        }
    }
    
    // Record move for each object (for XML save)
    for obj_id in &p.object_ids {
        // Check if object was already moved - accumulate deltas
        if let Some(existing) = state.moved_objects.get_mut(obj_id) {
            existing.delta_x += p.delta_x;
            existing.delta_y += p.delta_y;
        } else {
            state.moved_objects.insert(*obj_id, ObjectMove {
                delta_x: p.delta_x,
                delta_y: p.delta_y,
            });
        }
        
        // Record modified region for DRC (find the object range, clone it to avoid borrow issues)
        if let Some(range) = state.all_object_ranges.iter().find(|r| r.id == *obj_id).cloned() {
            state.record_modified_region(&range);
        }
    }
    
    // Rebuild the spatial index with updated positions
    rebuild_spatial_index(state);
    
    Response::success(id, serde_json::json!({
        "status": "ok",
        "moved_count": p.object_ids.len()
    }))
}

/// Rebuild the spatial index from all_object_ranges
fn rebuild_spatial_index(state: &mut ServerState) {
    use crate::draw::geometry::SelectableObject;
    use rstar::RTree;
    
    let selectable_objects: Vec<SelectableObject> = state.all_object_ranges.iter()
        .filter(|r| !state.deleted_objects.contains_key(&r.id))
        .cloned()
        .map(SelectableObject::new)
        .collect();
    
    state.spatial_index = Some(RTree::bulk_load(selectable_objects));
    eprintln!("[LSP Server] Rebuilt spatial index with {} objects", 
        state.spatial_index.as_ref().map(|t| t.size()).unwrap_or(0));
}

/// Handle UndoMove request - reverses a move operation for objects
pub fn handle_undo_move(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params {
        object_ids: Vec<u64>,
        delta_x: f32,
        delta_y: f32,
    }
    
    let p: Params = match parse_params(id.clone(), params, "{object_ids, delta_x, delta_y}") {
        Ok(p) => p,
        Err(e) => return e,
    };
    
    eprintln!("[LSP Server] UndoMove: {} objects by ({:.3}, {:.3})", 
        p.object_ids.len(), -p.delta_x, -p.delta_y);
    
    // Update all_object_ranges bounds - reverse the move
    for range in &mut state.all_object_ranges {
        if p.object_ids.contains(&range.id) {
            range.bounds[0] -= p.delta_x;
            range.bounds[1] -= p.delta_y;
            range.bounds[2] -= p.delta_x;
            range.bounds[3] -= p.delta_y;
        }
    }
    
    // Update moved_objects tracking
    for obj_id in &p.object_ids {
        if let Some(existing) = state.moved_objects.get_mut(obj_id) {
            existing.delta_x -= p.delta_x;
            existing.delta_y -= p.delta_y;
            
            // If back to zero, remove the entry
            if existing.delta_x.abs() < 0.0001 && existing.delta_y.abs() < 0.0001 {
                state.moved_objects.remove(obj_id);
            }
        }
    }
    
    // Rebuild the spatial index
    rebuild_spatial_index(state);
    
    Response::success(id, serde_json::json!({
        "status": "ok"
    }))
}

/// Handle RedoMove request - re-applies a move operation for objects
pub fn handle_redo_move(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params {
        object_ids: Vec<u64>,
        delta_x: f32,
        delta_y: f32,
    }
    
    let p: Params = match parse_params(id.clone(), params, "{object_ids, delta_x, delta_y}") {
        Ok(p) => p,
        Err(e) => return e,
    };
    
    eprintln!("[LSP Server] RedoMove: {} objects by ({:.3}, {:.3})", 
        p.object_ids.len(), p.delta_x, p.delta_y);
    
    // Update all_object_ranges bounds - re-apply the move
    for range in &mut state.all_object_ranges {
        if p.object_ids.contains(&range.id) {
            range.bounds[0] += p.delta_x;
            range.bounds[1] += p.delta_y;
            range.bounds[2] += p.delta_x;
            range.bounds[3] += p.delta_y;
        }
    }
    
    // Update moved_objects tracking
    for obj_id in &p.object_ids {
        if let Some(existing) = state.moved_objects.get_mut(obj_id) {
            existing.delta_x += p.delta_x;
            existing.delta_y += p.delta_y;
        } else {
            state.moved_objects.insert(*obj_id, ObjectMove {
                delta_x: p.delta_x,
                delta_y: p.delta_y,
            });
        }
    }
    
    // Rebuild the spatial index
    rebuild_spatial_index(state);
    
    Response::success(id, serde_json::json!({
        "status": "ok"
    }))
}

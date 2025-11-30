//! Selection handlers: Select, BoxSelect, point_hits_object

use crate::lsp::protocol::Response;
use crate::lsp::state::ServerState;
use crate::lsp::util::{point_in_triangle, parse_params};
use crate::draw::geometry::{LayerJSON, ObjectRange};
use serde::Deserialize;

/// Sort objects by priority: objects with nets first, then by type (pad > via > polygon > polyline)
pub fn sort_by_priority(objects: &mut [ObjectRange]) {
    objects.sort_by(|a, b| {
        let has_net_priority = |r: &ObjectRange| if r.net_name.is_some() { 0 } else { 1 };
        let net_cmp = has_net_priority(a).cmp(&has_net_priority(b));
        if net_cmp != std::cmp::Ordering::Equal {
            return net_cmp;
        }
        let type_priority = |t: u8| match t { 3 => 0, 2 => 1, 1 => 2, _ => 3 };
        type_priority(a.obj_type).cmp(&type_priority(b.obj_type))
    });
}

/// Check if a point hits an object's actual geometry (not just bounding box)
pub fn point_hits_object(px: f32, py: f32, range: &ObjectRange, layers: &[LayerJSON]) -> bool {
    let layer = match layers.iter().find(|l| l.layer_id == range.layer_id) {
        Some(l) => l,
        None => return true,
    };
    
    let geometry = match range.obj_type {
        0 => layer.geometry.batch.as_ref(),
        1 => layer.geometry.batch_colored.as_ref(),
        2 => layer.geometry.instanced.as_ref(),
        3 => layer.geometry.instanced_rot.as_ref(),
        _ => return true,
    };
    
    let lods = match geometry {
        Some(lods) if !lods.is_empty() => lods,
        _ => return true,
    };
    
    // Handle instanced geometry (vias, pads)
    if range.obj_type == 2 || range.obj_type == 3 {
        let shape_idx = range.shape_index.unwrap_or(0) as usize;
        if shape_idx >= lods.len() {
            return true;
        }
        let lod_entry = &lods[shape_idx];
        
        if let (Some(inst_data), Some(inst_idx)) = (&lod_entry.instance_data, range.instance_index) {
            let floats_per_instance = 3;
            let base = (inst_idx as usize) * floats_per_instance;
            if base + 1 < inst_data.len() {
                let inst_x = inst_data[base];
                let inst_y = inst_data[base + 1];
                
                if let Some(ref indices) = lod_entry.index_data {
                    for tri in indices.chunks(3) {
                        if tri.len() < 3 { continue; }
                        let i0 = tri[0] as usize * 2;
                        let i1 = tri[1] as usize * 2;
                        let i2 = tri[2] as usize * 2;
                        
                        if i2 + 1 < lod_entry.vertex_data.len() {
                            let x0 = lod_entry.vertex_data[i0] + inst_x;
                            let y0 = lod_entry.vertex_data[i0 + 1] + inst_y;
                            let x1 = lod_entry.vertex_data[i1] + inst_x;
                            let y1 = lod_entry.vertex_data[i1 + 1] + inst_y;
                            let x2 = lod_entry.vertex_data[i2] + inst_x;
                            let y2 = lod_entry.vertex_data[i2 + 1] + inst_y;
                            
                            if point_in_triangle(px, py, x0, y0, x1, y1, x2, y2) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }
    
    // For batched geometry (polylines, polygons)
    let lod0 = &lods[0];
    if range.vertex_ranges.is_empty() {
        return true;
    }
    
    let (start_vertex, vertex_count) = range.vertex_ranges[0];
    if vertex_count == 0 {
        return false;
    }
    
    if let Some(ref indices) = lod0.index_data {
        let start = start_vertex as usize;
        let end = start + vertex_count as usize;
        
        for tri in indices.chunks(3) {
            if tri.len() < 3 { continue; }
            
            let idx0 = tri[0] as usize;
            let idx1 = tri[1] as usize;
            let idx2 = tri[2] as usize;
            
            if idx0 >= start && idx0 < end && idx1 >= start && idx1 < end && idx2 >= start && idx2 < end {
                let i0 = idx0 * 2;
                let i1 = idx1 * 2;
                let i2 = idx2 * 2;
                
                if i2 + 1 < lod0.vertex_data.len() {
                    let x0 = lod0.vertex_data[i0];
                    let y0 = lod0.vertex_data[i0 + 1];
                    let x1 = lod0.vertex_data[i1];
                    let y1 = lod0.vertex_data[i1 + 1];
                    let x2 = lod0.vertex_data[i2];
                    let y2 = lod0.vertex_data[i2 + 1];
                    
                    if point_in_triangle(px, py, x0, y0, x1, y1, x2, y2) {
                        return true;
                    }
                }
            }
        }
    }
    
    false
}

/// Find all objects at a point with triangle intersection testing.
/// Returns objects sorted by priority (net > no net, pad > via > polygon > polyline).
pub fn find_objects_at_point(state: &ServerState, x: f32, y: f32) -> Vec<ObjectRange> {
    let Some(tree) = &state.spatial_index else {
        return vec![];
    };
    
    let point = [x, y];
    let candidates: Vec<_> = tree.locate_all_at_point(&point).collect();
    
    let mut results: Vec<ObjectRange> = candidates.iter()
        .filter(|obj| point_hits_object(x, y, &obj.range, &state.layers))
        .map(|obj| obj.range.clone())
        .collect();
    
    sort_by_priority(&mut results);
    results
}

/// Handle Select request - performs spatial selection at a point
pub fn handle_select(
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

    let results = find_objects_at_point(state, p.x, p.y);
    Response::success(id, serde_json::to_value(results).unwrap())
}

/// Handle BoxSelect request - performs spatial selection for a rectangle
pub fn handle_box_select(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params { min_x: f32, min_y: f32, max_x: f32, max_y: f32 }

    let p: Params = match parse_params(id.clone(), params, "{min_x, min_y, max_x, max_y}") {
        Ok(p) => p,
        Err(e) => return e,
    };

    if let Some(tree) = &state.spatial_index {
        use rstar::AABB;
        
        let envelope = AABB::from_corners([p.min_x, p.min_y], [p.max_x, p.max_y]);
        
        let mut results: Vec<ObjectRange> = tree.locate_in_envelope_intersecting(&envelope)
            .map(|obj| obj.range.clone())
            .collect();
        
        sort_by_priority(&mut results);
            
        Response::success(id, serde_json::to_value(results).unwrap())
    } else {
        Response::success(id, serde_json::json!([]))
    }
}

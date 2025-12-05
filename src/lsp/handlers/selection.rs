//! Selection handlers: Select, BoxSelect, point_hits_object

use crate::lsp::protocol::Response;
use crate::lsp::state::ServerState;
use crate::lsp::util::{point_in_triangle, parse_params};
use crate::draw::geometry::{LayerJSON, ObjectRange};
use serde::Deserialize;

/// Check if a line segment intersects with an AABB
#[inline]
fn segment_intersects_aabb(
    x0: f32, y0: f32, x1: f32, y1: f32,
    min_x: f32, min_y: f32, max_x: f32, max_y: f32,
) -> bool {
    // Quick reject: check if segment bounding box doesn't intersect AABB
    let seg_min_x = x0.min(x1);
    let seg_max_x = x0.max(x1);
    let seg_min_y = y0.min(y1);
    let seg_max_y = y0.max(y1);
    
    if seg_max_x < min_x || seg_min_x > max_x || seg_max_y < min_y || seg_min_y > max_y {
        return false;
    }
    
    // Check if segment endpoints are on opposite sides of any edge
    let dx = x1 - x0;
    let dy = y1 - y0;
    
    // Parametric line intersection with each edge
    let mut t_min = 0.0f32;
    let mut t_max = 1.0f32;
    
    // X axis
    if dx.abs() > 1e-10 {
        let t1 = (min_x - x0) / dx;
        let t2 = (max_x - x0) / dx;
        let (t_near, t_far) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
        t_min = t_min.max(t_near);
        t_max = t_max.min(t_far);
        if t_min > t_max { return false; }
    } else if x0 < min_x || x0 > max_x {
        return false;
    }
    
    // Y axis
    if dy.abs() > 1e-10 {
        let t1 = (min_y - y0) / dy;
        let t2 = (max_y - y0) / dy;
        let (t_near, t_far) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
        t_min = t_min.max(t_near);
        t_max = t_max.min(t_far);
        if t_min > t_max { return false; }
    } else if y0 < min_y || y0 > max_y {
        return false;
    }
    
    true
}

/// Check if a triangle intersects with an AABB (selection box)
fn triangle_intersects_aabb(
    x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32,
    min_x: f32, min_y: f32, max_x: f32, max_y: f32,
) -> bool {
    // 1. Check if any triangle vertex is inside the box
    let vertex_in_box = |x: f32, y: f32| x >= min_x && x <= max_x && y >= min_y && y <= max_y;
    if vertex_in_box(x0, y0) || vertex_in_box(x1, y1) || vertex_in_box(x2, y2) {
        return true;
    }
    
    // 2. Check if any box corner is inside the triangle
    let corners = [
        (min_x, min_y), (max_x, min_y),
        (min_x, max_y), (max_x, max_y),
    ];
    for (cx, cy) in corners {
        if point_in_triangle(cx, cy, x0, y0, x1, y1, x2, y2) {
            return true;
        }
    }
    
    // 3. Check if any triangle edge intersects the box
    if segment_intersects_aabb(x0, y0, x1, y1, min_x, min_y, max_x, max_y) {
        return true;
    }
    if segment_intersects_aabb(x1, y1, x2, y2, min_x, min_y, max_x, max_y) {
        return true;
    }
    if segment_intersects_aabb(x2, y2, x0, y0, min_x, min_y, max_x, max_y) {
        return true;
    }
    
    false
}

/// Check if a selection box intersects an object's actual geometry (not just bounding box)
/// `move_delta` is the (dx, dy) to apply if this object was moved
/// `rotation_delta` is the rotation angle in radians to apply if this object was rotated
/// `flip_info` is the (center_x, center_y, is_flipped, original_layer_id) to apply if this object was flipped
pub fn box_intersects_object(
    min_x: f32, min_y: f32, max_x: f32, max_y: f32,
    range: &ObjectRange, 
    layers: &[LayerJSON], 
    move_delta: Option<(f32, f32)>,
    rotation_delta: Option<f32>,
    flip_info: Option<(f32, f32, bool, &str)>
) -> bool {
    // If flipped, look up geometry in the ORIGINAL layer, not the current layer_id
    let layer_to_query = if let Some((_, _, true, original_layer)) = flip_info {
        original_layer
    } else {
        range.layer_id.as_str()
    };
    
    let layer = match layers.iter().find(|l| l.layer_id == layer_to_query) {
        Some(l) => l,
        None => return true, // Layer not found, assume it intersects
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
    
    // Apply move delta if object was moved
    let (dx, dy) = move_delta.unwrap_or((0.0, 0.0));
    
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
            if base + 2 < inst_data.len() {
                // Get original instance position
                let orig_x = inst_data[base];
                let orig_y = inst_data[base + 1];
                
                // Apply flip first (mirror around center_x)
                let (flipped_x, flipped_y) = if let Some((center_x, _center_y, is_flipped, _)) = flip_info {
                    if is_flipped {
                        (2.0 * center_x - orig_x, orig_y)
                    } else {
                        (orig_x, orig_y)
                    }
                } else {
                    (orig_x, orig_y)
                };
                
                // Then apply move delta
                let inst_x = flipped_x + dx;
                let inst_y = flipped_y + dy;
                let packed = inst_data[base + 2];
                
                // Extract rotation for instanced_rot (obj_type == 3) and add rotation delta
                let rotation = if range.obj_type == 3 {
                    let packed_bits = packed.to_bits();
                    let angle_u16 = packed_bits >> 16;
                    let angle_normalized = (angle_u16 as f32) / 65535.0;
                    let base_angle = angle_normalized * std::f32::consts::TAU;
                    base_angle + rotation_delta.unwrap_or(0.0)
                } else {
                    0.0f32
                };
                let cos_r = rotation.cos();
                let sin_r = rotation.sin();
                
                if let Some(ref indices) = lod_entry.index_data {
                    for tri in indices.chunks(3) {
                        if tri.len() < 3 { continue; }
                        let i0 = tri[0] as usize * 2;
                        let i1 = tri[1] as usize * 2;
                        let i2 = tri[2] as usize * 2;
                        
                        if i2 + 1 < lod_entry.vertex_data.len() {
                            // Get local vertices
                            let lx0 = lod_entry.vertex_data[i0];
                            let ly0 = lod_entry.vertex_data[i0 + 1];
                            let lx1 = lod_entry.vertex_data[i1];
                            let ly1 = lod_entry.vertex_data[i1 + 1];
                            let lx2 = lod_entry.vertex_data[i2];
                            let ly2 = lod_entry.vertex_data[i2 + 1];
                            
                            // Apply rotation then translation
                            let x0 = lx0 * cos_r - ly0 * sin_r + inst_x;
                            let y0 = lx0 * sin_r + ly0 * cos_r + inst_y;
                            let x1 = lx1 * cos_r - ly1 * sin_r + inst_x;
                            let y1 = lx1 * sin_r + ly1 * cos_r + inst_y;
                            let x2 = lx2 * cos_r - ly2 * sin_r + inst_x;
                            let y2 = lx2 * sin_r + ly2 * cos_r + inst_y;
                            
                            if triangle_intersects_aabb(x0, y0, x1, y1, x2, y2, min_x, min_y, max_x, max_y) {
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
                    let x0 = lod0.vertex_data[i0] + dx;
                    let y0 = lod0.vertex_data[i0 + 1] + dy;
                    let x1 = lod0.vertex_data[i1] + dx;
                    let y1 = lod0.vertex_data[i1 + 1] + dy;
                    let x2 = lod0.vertex_data[i2] + dx;
                    let y2 = lod0.vertex_data[i2 + 1] + dy;
                    
                    if triangle_intersects_aabb(x0, y0, x1, y1, x2, y2, min_x, min_y, max_x, max_y) {
                        return true;
                    }
                }
            }
        }
    }
    
    false
}

/// Sort objects by visual priority: layer order first (later = on top), then by type.
/// This matches the rendering order where later layers appear on top.
pub fn sort_by_priority(objects: &mut [ObjectRange], layers: &[LayerJSON]) {
    // Build layer index map for O(1) lookup
    let layer_indices: std::collections::HashMap<&str, usize> = layers
        .iter()
        .enumerate()
        .map(|(i, l)| (l.layer_id.as_str(), i))
        .collect();
    
    objects.sort_by(|a, b| {
        // Primary: layer order (higher index = rendered later = on top = higher priority)
        let a_layer_idx = layer_indices.get(a.layer_id.as_str()).copied().unwrap_or(0);
        let b_layer_idx = layer_indices.get(b.layer_id.as_str()).copied().unwrap_or(0);
        let layer_cmp = b_layer_idx.cmp(&a_layer_idx); // Reverse: higher index first
        if layer_cmp != std::cmp::Ordering::Equal {
            return layer_cmp;
        }
        
        // Secondary: objects with nets over objects without
        let has_net_priority = |r: &ObjectRange| if r.net_name.is_some() { 0 } else { 1 };
        let net_cmp = has_net_priority(a).cmp(&has_net_priority(b));
        if net_cmp != std::cmp::Ordering::Equal {
            return net_cmp;
        }
        
        // Tertiary: type priority (pad > via > polyline > polygon)
        let type_priority = |t: u8| match t { 3 => 0, 2 => 1, 0 => 2, 1 => 3, _ => 4 };
        type_priority(a.obj_type).cmp(&type_priority(b.obj_type))
    });
}

/// Check if a point hits an object's actual geometry (not just bounding box)
/// `move_delta` is the (dx, dy) to apply if this object was moved
/// `rotation_delta` is the rotation angle in radians to apply if this object was rotated
/// `flip_info` is the (center_x, center_y, is_flipped, original_layer_id) to apply if this object was flipped
pub fn point_hits_object(px: f32, py: f32, range: &ObjectRange, layers: &[LayerJSON], move_delta: Option<(f32, f32)>, rotation_delta: Option<f32>, flip_info: Option<(f32, f32, bool, &str)>) -> bool {
    let debug = std::env::var("DEBUG_SELECT").is_ok();
    if debug && range.obj_type == 3 {
        eprintln!("[DEBUG_SELECT] point_hits_object called for obj_type=3 pin={:?}", range.pin_ref);
    }
    
    // If flipped, look up geometry in the ORIGINAL layer, not the current layer_id
    let layer_to_query = if let Some((_, _, true, original_layer)) = flip_info {
        original_layer
    } else {
        range.layer_id.as_str()
    };
    
    let layer = match layers.iter().find(|l| l.layer_id == layer_to_query) {
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
    
    // Apply move delta if object was moved
    let (dx, dy) = move_delta.unwrap_or((0.0, 0.0));
    
    // Handle instanced geometry (vias, pads)
    if range.obj_type == 2 || range.obj_type == 3 {
        if debug && range.pin_ref.is_some() {
            eprintln!("[DEBUG_SELECT] Checking {} obj_type={} shape_idx={:?} inst_idx={:?} lods.len()={}",
                range.pin_ref.as_ref().unwrap(), range.obj_type, range.shape_index, range.instance_index, lods.len());
        }
        let shape_idx = range.shape_index.unwrap_or(0) as usize;
        if shape_idx >= lods.len() {
            if debug { eprintln!("[DEBUG_SELECT]   shape_idx {} >= lods.len() {}, returning true", shape_idx, lods.len()); }
            return true;
        }
        let lod_entry = &lods[shape_idx];
        
        if let (Some(inst_data), Some(inst_idx)) = (&lod_entry.instance_data, range.instance_index) {
            let floats_per_instance = 3;
            let base = (inst_idx as usize) * floats_per_instance;
            if base + 2 < inst_data.len() {
                // Get original instance position
                let orig_x = inst_data[base];
                let orig_y = inst_data[base + 1];
                
                // Apply flip first (mirror around center_x)
                let (flipped_x, flipped_y) = if let Some((center_x, _center_y, is_flipped, _)) = flip_info {
                    if is_flipped {
                        (2.0 * center_x - orig_x, orig_y)
                    } else {
                        (orig_x, orig_y)
                    }
                } else {
                    (orig_x, orig_y)
                };
                
                // Then apply move delta
                let inst_x = flipped_x + dx;
                let inst_y = flipped_y + dy;
                let packed = inst_data[base + 2];
                
                // Extract rotation for instanced_rot (obj_type == 3) and add rotation delta
                let rotation = if range.obj_type == 3 {
                    let packed_bits = packed.to_bits();
                    let angle_u16 = packed_bits >> 16;
                    let angle_normalized = (angle_u16 as f32) / 65535.0;
                    let base_angle = angle_normalized * std::f32::consts::TAU;
                    base_angle + rotation_delta.unwrap_or(0.0)
                } else {
                    0.0f32
                };
                let cos_r = rotation.cos();
                let sin_r = rotation.sin();
                
                if debug && range.pin_ref.is_some() {
                    eprintln!("[DEBUG_SELECT] Testing {} on {}: point=({:.2},{:.2}) inst=({:.2},{:.2}) rot={:.2}deg shape_idx={} inst_idx={} vertex_count={} has_indices={}",
                        range.pin_ref.as_ref().unwrap(), range.layer_id,
                        px, py, inst_x, inst_y, rotation.to_degrees(), shape_idx, inst_idx,
                        lod_entry.vertex_data.len() / 2, lod_entry.index_data.is_some());
                }
                
                if let Some(ref indices) = lod_entry.index_data {
                    let mut hit = false;
                    if debug && range.pin_ref.is_some() {
                        eprintln!("[DEBUG_SELECT]   {} triangles, vertex_data.len()={}", 
                            indices.len() / 3, lod_entry.vertex_data.len());
                    }
                    for tri in indices.chunks(3) {
                        if tri.len() < 3 { continue; }
                        let i0 = tri[0] as usize * 2;
                        let i1 = tri[1] as usize * 2;
                        let i2 = tri[2] as usize * 2;
                        
                        if i2 + 1 < lod_entry.vertex_data.len() {
                            // Get local vertices
                            let lx0 = lod_entry.vertex_data[i0];
                            let ly0 = lod_entry.vertex_data[i0 + 1];
                            let lx1 = lod_entry.vertex_data[i1];
                            let ly1 = lod_entry.vertex_data[i1 + 1];
                            let lx2 = lod_entry.vertex_data[i2];
                            let ly2 = lod_entry.vertex_data[i2 + 1];
                            
                            // Apply rotation then translation
                            let x0 = lx0 * cos_r - ly0 * sin_r + inst_x;
                            let y0 = lx0 * sin_r + ly0 * cos_r + inst_y;
                            let x1 = lx1 * cos_r - ly1 * sin_r + inst_x;
                            let y1 = lx1 * sin_r + ly1 * cos_r + inst_y;
                            let x2 = lx2 * cos_r - ly2 * sin_r + inst_x;
                            let y2 = lx2 * sin_r + ly2 * cos_r + inst_y;
                            
                            if debug && range.pin_ref.is_some() {
                                eprintln!("[DEBUG_SELECT]   tri: ({:.2},{:.2})-({:.2},{:.2})-({:.2},{:.2}) point=({:.2},{:.2})",
                                    x0, y0, x1, y1, x2, y2, px, py);
                            }
                            
                            if point_in_triangle(px, py, x0, y0, x1, y1, x2, y2) {
                                hit = true;
                                if debug && range.pin_ref.is_some() {
                                    eprintln!("[DEBUG_SELECT]   HIT! triangle: ({:.2},{:.2})-({:.2},{:.2})-({:.2},{:.2})",
                                        x0, y0, x1, y1, x2, y2);
                                }
                                break;
                            }
                        }
                    }
                    if debug && range.pin_ref.is_some() && !hit {
                        // Print the shape bounds for debugging
                        let mut min_x = f32::MAX;
                        let mut max_x = f32::MIN;
                        let mut min_y = f32::MAX;
                        let mut max_y = f32::MIN;
                        for i in 0..(lod_entry.vertex_data.len()/2) {
                            let lx = lod_entry.vertex_data[i*2];
                            let ly = lod_entry.vertex_data[i*2+1];
                            let wx = lx * cos_r - ly * sin_r + inst_x;
                            let wy = lx * sin_r + ly * cos_r + inst_y;
                            min_x = min_x.min(wx);
                            max_x = max_x.max(wx);
                            min_y = min_y.min(wy);
                            max_y = max_y.max(wy);
                        }
                        eprintln!("[DEBUG_SELECT]   MISS - shape world bounds: ({:.2},{:.2})-({:.2},{:.2})",
                            min_x, min_y, max_x, max_y);
                    }
                    if hit {
                        return true;
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
                    // Apply move delta to vertex positions
                    let x0 = lod0.vertex_data[i0] + dx;
                    let y0 = lod0.vertex_data[i0 + 1] + dy;
                    let x1 = lod0.vertex_data[i1] + dx;
                    let y1 = lod0.vertex_data[i1 + 1] + dy;
                    let x2 = lod0.vertex_data[i2] + dx;
                    let y2 = lod0.vertex_data[i2 + 1] + dy;
                    
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
/// If `only_visible` is true, hidden layers are excluded from results.
pub fn find_objects_at_point(state: &ServerState, x: f32, y: f32, only_visible: bool) -> Vec<ObjectRange> {
    let Some(tree) = &state.spatial_index else {
        return vec![];
    };
    
    let point = [x, y];
    let candidates: Vec<_> = tree.locate_all_at_point(&point).collect();
    
    let mut results: Vec<ObjectRange> = candidates.iter()
        .filter(|obj| {
            // Skip objects on hidden layers if only_visible is true
            if only_visible && state.hidden_layers.contains(&obj.range.layer_id) {
                return false;
            }
            // Get move delta if this object was moved
            let move_delta = state.moved_objects.get(&obj.range.id)
                .map(|m| (m.delta_x, m.delta_y));
            // Get rotation delta if this object was rotated
            let rotation_delta = state.rotated_objects.get(&obj.range.id)
                .map(|r| r.delta_radians);
            // Get flip info if this object was flipped (includes original layer for geometry lookup)
            let flip_info = state.flipped_objects.get(&obj.range.id)
                .map(|f| (f.center_x, f.center_y, f.flip_count % 2 == 1, f.original_layer_id.as_str()));
            point_hits_object(x, y, &obj.range, &state.layers, move_delta, rotation_delta, flip_info)
        })
        .map(|obj| obj.range.clone())
        .collect();
    
    sort_by_priority(&mut results, &state.layers);
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

    let results = find_objects_at_point(state, p.x, p.y, true);
    Response::success(id, serde_json::to_value(results).unwrap())
}

/// Handle BoxSelect request - performs spatial selection for a rectangle
/// Uses AABB for initial filtering, then triangle intersection for precise matching
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
        
        // First pass: AABB intersection
        let candidates: Vec<_> = tree.locate_in_envelope_intersecting(&envelope).collect();
        
        // Second pass: precise triangle intersection testing
        let mut results: Vec<ObjectRange> = candidates.iter()
            .filter(|obj| {
                // Skip objects on hidden layers
                if state.hidden_layers.contains(&obj.range.layer_id) {
                    return false;
                }
                // Get move delta if this object was moved
                let move_delta = state.moved_objects.get(&obj.range.id)
                    .map(|m| (m.delta_x, m.delta_y));
                // Get rotation delta if this object was rotated
                let rotation_delta = state.rotated_objects.get(&obj.range.id)
                    .map(|r| r.delta_radians);
                // Get flip info if this object was flipped (includes original layer for geometry lookup)
                let flip_info = state.flipped_objects.get(&obj.range.id)
                    .map(|f| (f.center_x, f.center_y, f.flip_count % 2 == 1, f.original_layer_id.as_str()));
                box_intersects_object(p.min_x, p.min_y, p.max_x, p.max_y, &obj.range, &state.layers, move_delta, rotation_delta, flip_info)
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        sort_by_priority(&mut results, &state.layers);
            
        Response::success(id, serde_json::to_value(results).unwrap())
    } else {
        Response::success(id, serde_json::json!([]))
    }
}

/// Handle CheckPointHitsSelection request - checks if a point hits any of the given object IDs
/// Uses full triangle intersection testing, not just AABB
/// Returns the first hit object ID, or null if no hit
pub fn handle_check_point_hits_selection(
    state: &ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct Params {
        x: f32,
        y: f32,
        object_ids: Vec<u64>,
    }

    let p: Params = match parse_params(id.clone(), params, "{x, y, object_ids}") {
        Ok(p) => p,
        Err(e) => return e,
    };

    // Build a set of object IDs for fast lookup
    let target_ids: std::collections::HashSet<u64> = p.object_ids.into_iter().collect();
    
    // Find all objects at the point using full geometry intersection
    let hits = find_objects_at_point(state, p.x, p.y, true);
    
    // Check if any of the hits are in our target set
    // Return the first (highest priority) hit that matches
    for hit in &hits {
        if target_ids.contains(&hit.id) {
            return Response::success(id, serde_json::json!({
                "hit": true,
                "object_id": hit.id
            }));
        }
    }
    
    Response::success(id, serde_json::json!({
        "hit": false,
        "object_id": null
    }))
}

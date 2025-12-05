//! Transform handlers: StartTransform, TransformPreview, ApplyTransform, CancelTransform
//! 
//! This module implements server-side transform logic for move/rotate/flip operations.
//! The WebView sends keypresses (R, F) and mouse deltas, and the LSP returns transformed
//! instance positions ready for GPU upload.
//!
//! All geometry data is already in memory from tessellation - WebView only sends commands.

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::lsp::util::parse_params;
use crate::draw::geometry::ObjectRange;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Original instance position (stored when transform starts)
#[derive(Debug, Clone)]
pub struct OriginalInstance {
    pub x: f32,
    pub y: f32,
    pub packed_rot_vis: u32,
    pub layer_id: String,
    pub shape_idx: u32,
    pub instance_idx: u32,
}

/// Active transform session state
#[derive(Debug, Clone)]
pub struct TransformSession {
    /// Object IDs being transformed
    pub object_ids: Vec<u64>,
    /// Component center for rotation/flip
    pub center: (f32, f32),
    /// Original object ranges (for cancel/undo)
    pub original_ranges: Vec<ObjectRange>,
    /// Original instance positions: object_id -> OriginalInstance
    pub original_instances: HashMap<u64, OriginalInstance>,
    /// Current cumulative rotation in radians
    pub rotation: f32,
    /// Current flip count (odd = flipped)
    pub flip_count: u32,
    /// Current translation
    pub delta_x: f32,
    pub delta_y: f32,
}

/// Parameters for StartTransform
#[derive(Deserialize)]
struct StartTransformParams {
    object_ids: Vec<u64>,
}

/// Parameters for TransformPreview
#[derive(Deserialize)]
struct TransformPreviewParams {
    /// Incremental rotation in degrees (+90 or -90 typically)
    #[serde(default)]
    rotate_degrees: Option<f32>,
    /// Toggle flip state
    #[serde(default)]
    flip: Option<bool>,
    /// Absolute translation from start position
    #[serde(default)]
    delta_x: Option<f32>,
    #[serde(default)]
    delta_y: Option<f32>,
}

/// Transformed instance for a single object
#[derive(Serialize)]
struct TransformedInstance {
    object_id: u64,
    layer_id: String,
    /// The original layer where the GPU buffer data lives (for buffer updates during preview)
    original_layer_id: String,
    x: f32,
    y: f32,
    packed_rot_vis: u32,
    shape_idx: u32,
    instance_idx: u32,
}

/// Handle StartTransform - begin a transform session for selected objects
pub fn handle_start_transform(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    let p: StartTransformParams = match parse_params(id.clone(), params, "{object_ids}") {
        Ok(p) => p,
        Err(e) => return e,
    };

    if p.object_ids.is_empty() {
        return Response::error(id, error_codes::INVALID_PARAMS, "No objects specified".to_string());
    }

    // Find the objects and their ranges
    let mut original_ranges: Vec<ObjectRange> = Vec::new();
    let mut original_instances: HashMap<u64, OriginalInstance> = HashMap::new();
    
    for obj_id in &p.object_ids {
        if let Some(range) = state.all_object_ranges.iter().find(|r| r.id == *obj_id) {
            original_ranges.push(range.clone());
            
            // For instanced objects (pads/vias), look up the instance data from layers
            if range.instance_index.is_some() && range.shape_index.is_some() {
                let shape_idx = range.shape_index.unwrap();
                
                // Find the layer's geometry data
                if let Some(layer_json) = state.layers.iter().find(|l| l.layer_id == range.layer_id) {
                    // Check instanced_rot (pads) first, then instanced (vias)
                    let instance_data = layer_json.geometry.instanced_rot.as_ref()
                        .or(layer_json.geometry.instanced.as_ref());
                    
                    if let Some(lods) = instance_data {
                        // Use shape_idx to find the correct LOD entry (each shape group is a separate entry)
                        if let Some(lod) = lods.get(shape_idx as usize) {
                            if let Some(inst_data) = &lod.instance_data {
                                // Instance data format: [x, y, packed_rot_vis, x, y, packed_rot_vis, ...]
                                // Each instance is 3 floats
                                let instance_idx = range.instance_index.unwrap() as usize;
                                let offset = instance_idx * 3;
                                
                                if offset + 2 < inst_data.len() {
                                    let x = inst_data[offset];
                                    let y = inst_data[offset + 1];
                                    let packed_rot_vis = inst_data[offset + 2].to_bits();
                                    
                                    original_instances.insert(*obj_id, OriginalInstance {
                                        x,
                                        y,
                                        packed_rot_vis,
                                        layer_id: range.layer_id.clone(),
                                        shape_idx,
                                        instance_idx: instance_idx as u32,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            
            // For non-instanced objects (polylines/polygons), use bounds center
            if !original_instances.contains_key(obj_id) {
                let x = (range.bounds[0] + range.bounds[2]) / 2.0;
                let y = (range.bounds[1] + range.bounds[3]) / 2.0;
                original_instances.insert(*obj_id, OriginalInstance {
                    x,
                    y,
                    packed_rot_vis: pack_rotation_vis(0.0, true, false),
                    layer_id: range.layer_id.clone(),
                    shape_idx: range.shape_index.unwrap_or(0),
                    instance_idx: range.instance_index.unwrap_or(0) as u32,
                });
            }
        }
    }

    if original_ranges.is_empty() {
        return Response::error(id, error_codes::INVALID_PARAMS, "No valid objects found".to_string());
    }

    // Calculate component center from bounds
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    
    for range in &original_ranges {
        min_x = min_x.min(range.bounds[0]);
        min_y = min_y.min(range.bounds[1]);
        max_x = max_x.max(range.bounds[2]);
        max_y = max_y.max(range.bounds[3]);
    }
    
    let center_x = (min_x + max_x) / 2.0;
    let center_y = (min_y + max_y) / 2.0;

    eprintln!("[LSP] StartTransform: {} objects, {} instanced, center=({:.3}, {:.3})", 
        p.object_ids.len(), original_instances.len(), center_x, center_y);

    // Create transform session
    let session = TransformSession {
        object_ids: p.object_ids.clone(),
        center: (center_x, center_y),
        original_ranges,
        original_instances,
        rotation: 0.0,
        flip_count: 0,
        delta_x: 0.0,
        delta_y: 0.0,
    };
    
    state.transform_session = Some(session);

    Response::success(id, serde_json::json!({
        "status": "ok",
        "object_count": p.object_ids.len(),
        "center": { "x": center_x, "y": center_y }
    }))
}

/// Handle TransformPreview - apply incremental transform and return transformed positions
pub fn handle_transform_preview(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    let p: TransformPreviewParams = match parse_params(id.clone(), params, "{rotate_degrees?, flip?, delta_x?, delta_y?}") {
        Ok(p) => p,
        Err(e) => return e,
    };

    let session = match &mut state.transform_session {
        Some(s) => s,
        None => {
            return Response::error(id, error_codes::INVALID_REQUEST, 
                "No active transform session - call StartTransform first".to_string());
        }
    };

    // Apply incremental rotation (cumulative)
    if let Some(degrees) = p.rotate_degrees {
        let radians = degrees * std::f32::consts::PI / 180.0;
        session.rotation += radians;
        // Normalize to 0-2π
        while session.rotation >= std::f32::consts::TAU {
            session.rotation -= std::f32::consts::TAU;
        }
        while session.rotation < 0.0 {
            session.rotation += std::f32::consts::TAU;
        }
    }

    // Toggle flip
    if p.flip == Some(true) {
        session.flip_count += 1;
    }

    // Update translation (absolute from start)
    if let Some(dx) = p.delta_x {
        session.delta_x = dx;
    }
    if let Some(dy) = p.delta_y {
        session.delta_y = dy;
    }

    let is_flipped = session.flip_count % 2 == 1;
    let cx = session.center.0;
    let cy = session.center.1;
    let rotation = session.rotation;
    let dx = session.delta_x;
    let dy = session.delta_y;

    // Transform each object's instance position
    let mut transformed_instances: Vec<TransformedInstance> = Vec::new();
    
    for (obj_id, original) in &session.original_instances {
        // Apply transform chain: flip → rotate → translate
        let mut x = original.x;
        let mut y = original.y;

        // 1. Flip around center (X-axis mirror)
        if is_flipped {
            x = 2.0 * cx - x;
        }

        // 2. Rotate around center
        let rel_x = x - cx;
        let rel_y = y - cy;
        let cos = rotation.cos();
        let sin = rotation.sin();
        x = cx + rel_x * cos - rel_y * sin;
        y = cy + rel_x * sin + rel_y * cos;

        // 3. Translate
        x += dx;
        y += dy;

        // Calculate new packed rotation/visibility
        let orig_rotation = unpack_rotation(original.packed_rot_vis);
        let new_rotation = if is_flipped {
            // When flipped, mirror the rotation
            std::f32::consts::PI - orig_rotation + rotation
        } else {
            orig_rotation + rotation
        };
        let new_packed = pack_rotation_vis(new_rotation, true, true); // visible=true, moving=true

        // Determine layer for flipped objects
        let layer_id = if is_flipped {
            state.layer_pairs.get(&original.layer_id)
                .cloned()
                .unwrap_or_else(|| original.layer_id.clone())
        } else {
            original.layer_id.clone()
        };

        transformed_instances.push(TransformedInstance {
            object_id: *obj_id,
            layer_id,
            original_layer_id: original.layer_id.clone(),
            x,
            y,
            packed_rot_vis: new_packed,
            shape_idx: original.shape_idx,
            instance_idx: original.instance_idx,
        });
    }

    let rotation_degrees = session.rotation * 180.0 / std::f32::consts::PI;
    
    eprintln!("[LSP] TransformPreview: rot={:.1}°, flipped={}, dx={:.3}, dy={:.3}, {} instances",
        rotation_degrees, is_flipped, dx, dy, transformed_instances.len());

    Response::success(id, serde_json::json!({
        "instances": transformed_instances,
        "rotation_degrees": rotation_degrees,
        "is_flipped": is_flipped,
        "delta_x": dx,
        "delta_y": dy
    }))
}

/// Handle ApplyTransform - commit the current transform to the spatial index
pub fn handle_apply_transform(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    _params: Option<serde_json::Value>,
) -> Response {
    let session = match state.transform_session.take() {
        Some(s) => s,
        None => {
            return Response::error(id, error_codes::INVALID_REQUEST, 
                "No active transform session".to_string());
        }
    };

    let is_flipped = session.flip_count % 2 == 1;
    let cx = session.center.0;
    let cy = session.center.1;
    let rotation = session.rotation;
    let dx = session.delta_x;
    let dy = session.delta_y;

    eprintln!("[LSP] ApplyTransform: {} objects, rot={:.1}°, flipped={}, delta=({:.3}, {:.3})",
        session.object_ids.len(), 
        rotation * 180.0 / std::f32::consts::PI,
        is_flipped, dx, dy);

    // Collect modified ranges for DRC tracking
    let mut modified_ranges: Vec<ObjectRange> = Vec::new();

    // Update all_object_ranges with transformed positions
    for obj_id in &session.object_ids {
        if let Some(range) = state.all_object_ranges.iter_mut().find(|r| r.id == *obj_id) {
            if let Some(original) = session.original_instances.get(obj_id) {
                // Apply transform to get new center
                let mut x = original.x;
                let mut y = original.y;

                if is_flipped {
                    x = 2.0 * cx - x;
                }

                let rel_x = x - cx;
                let rel_y = y - cy;
                let cos = rotation.cos();
                let sin = rotation.sin();
                x = cx + rel_x * cos - rel_y * sin;
                y = cy + rel_x * sin + rel_y * cos;

                x += dx;
                y += dy;

                // Update bounds centered on new position
                let half_w = (range.bounds[2] - range.bounds[0]) / 2.0;
                let half_h = (range.bounds[3] - range.bounds[1]) / 2.0;

                // Swap width/height if rotated 90° or 270°
                let rotated_90 = (rotation.abs() - std::f32::consts::FRAC_PI_2).abs() < 0.01
                    || (rotation.abs() - 3.0 * std::f32::consts::FRAC_PI_2).abs() < 0.01;
                
                let (final_half_w, final_half_h) = if rotated_90 {
                    (half_h, half_w)
                } else {
                    (half_w, half_h)
                };

                range.bounds[0] = x - final_half_w;
                range.bounds[1] = y - final_half_h;
                range.bounds[2] = x + final_half_w;
                range.bounds[3] = y + final_half_h;

                // Update layer if flipped
                if is_flipped {
                    if let Some(paired) = state.layer_pairs.get(&original.layer_id) {
                        range.layer_id = paired.clone();
                    }
                }

                modified_ranges.push(range.clone());
            }
        }
    }

    // Record modified regions after the mutable borrow ends
    for range in &modified_ranges {
        state.record_modified_region(range);
    }

    // Record move/rotation/flip for undo system and XML save
    // NOTE: We update instance_data and bounds directly in ApplyTransform, so we should NOT
    // also record in moved_objects (which would cause double-application in hit testing).
    // However, we still need to track moves for XML save. The XML save should read from
    // the updated instance_data, not from moved_objects.
    // 
    // TODO: Refactor to separate "geometry state" from "pending edit tracking"
    // For now, skip moved_objects update since geometry is already updated.
    // 
    // for obj_id in &session.object_ids {
    //     if dx.abs() > 0.0001 || dy.abs() > 0.0001 {
    //         if let Some(existing) = state.moved_objects.get_mut(obj_id) {
    //             existing.delta_x += dx;
    //             existing.delta_y += dy;
    //         } else {
    //             state.moved_objects.insert(*obj_id, crate::lsp::state::ObjectMove { 
    //                 delta_x: dx, 
    //                 delta_y: dy 
    //             });
    //         }
    //     }
    // }
    
    // NOTE: We do NOT update rotated_objects here because the rotation is already
    // stored in the updated instance_data (packed_rot_vis). Adding to rotated_objects
    // would cause DOUBLE-application in hit testing (which reads from packed_rot_vis
    // AND adds rotation_delta from rotated_objects).
    // 
    // for obj_id in &session.object_ids {
    //     if rotation.abs() > 0.0001 {
    //         if let Some(existing) = state.rotated_objects.get_mut(obj_id) {
    //             existing.delta_radians += rotation;
    //             while existing.delta_radians >= std::f32::consts::TAU {
    //                 existing.delta_radians -= std::f32::consts::TAU;
    //             }
    //             while existing.delta_radians < 0.0 {
    //                 existing.delta_radians += std::f32::consts::TAU;
    //             }
    //         } else {
    //             state.rotated_objects.insert(*obj_id, crate::lsp::state::ObjectRotation {
    //                 delta_radians: rotation,
    //             });
    //         }
    //     }
    // }

    // After ApplyTransform, we've already updated the instance_data in the target layer
    // and updated range.layer_id. We should NOT track in flipped_objects because that
    // would cause double-flip logic in hit testing (same issue as rotated_objects).
    // 
    // for obj_id in &session.object_ids {
    //     if is_flipped {
    //         if let Some(original) = session.original_instances.get(obj_id) {
    //             let flipped_layer = state.layer_pairs.get(&original.layer_id)
    //                 .cloned()
    //                 .unwrap_or_else(|| original.layer_id.clone());
    //             
    //             if let Some(existing) = state.flipped_objects.get_mut(obj_id) {
    //                 existing.flip_count += 1;
    //             } else {
    //                 state.flipped_objects.insert(*obj_id, crate::lsp::state::ObjectFlip {
    //                     original_layer_id: original.layer_id.clone(),
    //                     flipped_layer_id: flipped_layer,
    //                     center_x: cx,
    //                     center_y: cy,
    //                     flip_count: 1,
    //                 });
    //             }
    //         }
    //     }
    // }

    // Update layer instance_data so future StartTransform reads correct positions
    for (obj_id, original) in &session.original_instances {
        // Calculate transformed position
        let mut x = original.x;
        let mut y = original.y;

        if is_flipped {
            x = 2.0 * cx - x;
        }

        let rel_x = x - cx;
        let rel_y = y - cy;
        let cos = rotation.cos();
        let sin = rotation.sin();
        x = cx + rel_x * cos - rel_y * sin;
        y = cy + rel_x * sin + rel_y * cos;
        x += dx;
        y += dy;

        // Calculate new packed rotation
        let orig_rotation = unpack_rotation(original.packed_rot_vis);
        let new_rotation = if is_flipped {
            std::f32::consts::PI - orig_rotation + rotation
        } else {
            orig_rotation + rotation
        };
        let new_packed = pack_rotation_vis(new_rotation, true, false); // visible=true, moving=false

        // Determine target layer
        let target_layer_id = if is_flipped {
            state.layer_pairs.get(&original.layer_id)
                .cloned()
                .unwrap_or_else(|| original.layer_id.clone())
        } else {
            original.layer_id.clone()
        };

        // Find the layer and update instance_data
        if let Some(layer_json) = state.layers.iter_mut().find(|l| l.layer_id == target_layer_id) {
            // Check obj_type to determine instanced_rot vs instanced
            // Pads use instanced_rot, vias use instanced
            if let Some(range) = state.all_object_ranges.iter().find(|r| r.id == *obj_id) {
                let lods = if range.obj_type == 3 {
                    layer_json.geometry.instanced_rot.as_mut()
                } else if range.obj_type == 2 {
                    layer_json.geometry.instanced.as_mut()
                } else {
                    None
                };

                if let Some(lods) = lods {
                    let shape_idx = original.shape_idx as usize;
                    if let Some(lod) = lods.get_mut(shape_idx) {
                        if let Some(inst_data) = &mut lod.instance_data {
                            let instance_idx = original.instance_idx as usize;
                            let offset = instance_idx * 3;
                            if offset + 2 < inst_data.len() {
                                inst_data[offset] = x;
                                inst_data[offset + 1] = y;
                                inst_data[offset + 2] = f32::from_bits(new_packed);
                            }
                        }
                    }
                }
            }
        }
    }

    // Build undo action with original and final positions
    let mut original_positions: HashMap<u64, (f32, f32, u32)> = HashMap::new();
    let mut final_positions: HashMap<u64, (f32, f32, u32)> = HashMap::new();
    
    for (obj_id, original) in &session.original_instances {
        original_positions.insert(*obj_id, (original.x, original.y, original.packed_rot_vis));
        
        // Calculate final position (same logic as above)
        let mut x = original.x;
        let mut y = original.y;
        if is_flipped { x = 2.0 * cx - x; }
        let rel_x = x - cx;
        let rel_y = y - cy;
        let cos = rotation.cos();
        let sin = rotation.sin();
        x = cx + rel_x * cos - rel_y * sin;
        y = cy + rel_x * sin + rel_y * cos;
        x += dx;
        y += dy;
        
        let orig_rotation = unpack_rotation(original.packed_rot_vis);
        let new_rotation = if is_flipped {
            std::f32::consts::PI - orig_rotation + rotation
        } else {
            orig_rotation + rotation
        };
        let new_packed = pack_rotation_vis(new_rotation, true, false);
        
        final_positions.insert(*obj_id, (x, y, new_packed));
    }
    
    // Push to undo stack
    let undo_action = crate::lsp::state::TransformAction {
        object_ids: session.object_ids.clone(),
        delta_x: dx,
        delta_y: dy,
        rotate_degrees: rotation * 180.0 / std::f32::consts::PI,
        flipped: is_flipped,
        center: session.center,
        original_positions,
        final_positions,
    };
    
    state.undo_stack.push(undo_action);
    // Clear redo stack on new action
    state.redo_stack.clear();
    
    // Limit undo stack size
    const MAX_UNDO_STACK: usize = 100;
    if state.undo_stack.len() > MAX_UNDO_STACK {
        state.undo_stack.remove(0);
    }

    // Rebuild spatial index
    crate::lsp::handlers::edit::rebuild_spatial_index(state);

    Response::success(id, serde_json::json!({
        "status": "ok",
        "transformed_count": session.object_ids.len()
    }))
}

/// Handle CancelTransform - discard the current transform, return original positions
pub fn handle_cancel_transform(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    _params: Option<serde_json::Value>,
) -> Response {
    let session = match state.transform_session.take() {
        Some(s) => s,
        None => {
            return Response::success(id, serde_json::json!({
                "status": "ok",
                "message": "No active transform session"
            }));
        }
    };

    eprintln!("[LSP] CancelTransform: {} objects", session.object_ids.len());

    // Return original positions for WebView to restore
    let original_instances: Vec<TransformedInstance> = session.original_instances.iter()
        .map(|(obj_id, orig)| {
            // Clear moving flag, keep visible
            let packed = pack_rotation_vis(unpack_rotation(orig.packed_rot_vis), true, false);
            TransformedInstance {
                object_id: *obj_id,
                layer_id: orig.layer_id.clone(),
                original_layer_id: orig.layer_id.clone(), // Same as layer_id for cancel
                x: orig.x,
                y: orig.y,
                packed_rot_vis: packed,
                shape_idx: orig.shape_idx,
                instance_idx: orig.instance_idx,
            }
        })
        .collect();

    Response::success(id, serde_json::json!({
        "status": "ok",
        "instances": original_instances
    }))
}

/// Unpack rotation from packed_rot_vis
/// Format: [16-bit angle][14-bit unused][1-bit moving][1-bit visible]
fn unpack_rotation(packed: u32) -> f32 {
    let angle_u16 = (packed >> 16) as u16;
    let angle_normalized = (angle_u16 as f32) / 65535.0;
    angle_normalized * std::f32::consts::TAU
}

/// Pack rotation and visibility flags
/// Format: [16-bit angle][14-bit unused][1-bit moving][1-bit visible]
fn pack_rotation_vis(rotation: f32, visible: bool, moving: bool) -> u32 {
    // Normalize rotation to 0-2π
    let mut rot = rotation;
    while rot < 0.0 { rot += std::f32::consts::TAU; }
    while rot >= std::f32::consts::TAU { rot -= std::f32::consts::TAU; }
    
    // Convert to 16-bit (0..65535)
    let angle_u16 = ((rot / std::f32::consts::TAU) * 65535.0) as u16;
    
    // Pack: [angle(16 bits) | unused(14 bits) | moving(1 bit) | visible(1 bit)]
    let mut packed = (angle_u16 as u32) << 16;
    if visible { packed |= 1; }
    if moving { packed |= 2; }
    
    packed
}

/// Handle UndoTransform - undo the last transform operation
pub fn handle_undo_transform(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    _params: Option<serde_json::Value>,
) -> Response {
    // Check for active session - can't undo while transforming
    if state.transform_session.is_some() {
        return Response::error(id, error_codes::INVALID_REQUEST, 
            "Cannot undo while transform is in progress".to_string());
    }
    
    let action = match state.undo_stack.pop() {
        Some(a) => a,
        None => {
            return Response::success(id, serde_json::json!({
                "status": "ok",
                "message": "Nothing to undo",
                "instances": []
            }));
        }
    };
    
    eprintln!("[LSP] UndoTransform: {} objects", action.object_ids.len());
    
    // Apply original positions
    let instances = apply_positions(state, &action.object_ids, &action.original_positions);
    
    // Push to redo stack
    state.redo_stack.push(action);
    
    // Rebuild spatial index
    crate::lsp::handlers::edit::rebuild_spatial_index(state);
    
    Response::success(id, serde_json::json!({
        "status": "ok",
        "instances": instances
    }))
}

/// Handle RedoTransform - redo the last undone transform
pub fn handle_redo_transform(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    _params: Option<serde_json::Value>,
) -> Response {
    // Check for active session - can't redo while transforming
    if state.transform_session.is_some() {
        return Response::error(id, error_codes::INVALID_REQUEST, 
            "Cannot redo while transform is in progress".to_string());
    }
    
    let action = match state.redo_stack.pop() {
        Some(a) => a,
        None => {
            return Response::success(id, serde_json::json!({
                "status": "ok",
                "message": "Nothing to redo",
                "instances": []
            }));
        }
    };
    
    eprintln!("[LSP] RedoTransform: {} objects", action.object_ids.len());
    
    // Apply final positions
    let instances = apply_positions(state, &action.object_ids, &action.final_positions);
    
    // Push back to undo stack
    state.undo_stack.push(action);
    
    // Rebuild spatial index
    crate::lsp::handlers::edit::rebuild_spatial_index(state);
    
    Response::success(id, serde_json::json!({
        "status": "ok",
        "instances": instances
    }))
}

/// Apply positions from a position map and return instances for WebView update
fn apply_positions(
    state: &mut ServerState,
    object_ids: &[u64],
    positions: &HashMap<u64, (f32, f32, u32)>,
) -> Vec<TransformedInstance> {
    let mut instances: Vec<TransformedInstance> = Vec::new();
    
    for obj_id in object_ids {
        if let Some((x, y, packed)) = positions.get(obj_id) {
            // Find the object range to get layer/shape/instance info
            if let Some(range) = state.all_object_ranges.iter_mut().find(|r| r.id == *obj_id) {
                let layer_id = range.layer_id.clone();
                let shape_idx = range.shape_index.unwrap_or(0);
                let instance_idx = range.instance_index.unwrap_or(0);
                
                // Update bounds
                let half_w = (range.bounds[2] - range.bounds[0]) / 2.0;
                let half_h = (range.bounds[3] - range.bounds[1]) / 2.0;
                range.bounds[0] = x - half_w;
                range.bounds[1] = y - half_h;
                range.bounds[2] = x + half_w;
                range.bounds[3] = y + half_h;
                
                // Update layer instance_data
                if let Some(layer_json) = state.layers.iter_mut().find(|l| l.layer_id == layer_id) {
                    let lods = if range.obj_type == 3 {
                        layer_json.geometry.instanced_rot.as_mut()
                    } else if range.obj_type == 2 {
                        layer_json.geometry.instanced.as_mut()
                    } else {
                        None
                    };
                    
                    if let Some(lods) = lods {
                        let shape_idx_usize = shape_idx as usize;
                        if let Some(lod) = lods.get_mut(shape_idx_usize) {
                            if let Some(inst_data) = &mut lod.instance_data {
                                let instance_idx_usize = instance_idx as usize;
                                let offset = instance_idx_usize * 3;
                                if offset + 2 < inst_data.len() {
                                    inst_data[offset] = *x;
                                    inst_data[offset + 1] = *y;
                                    inst_data[offset + 2] = f32::from_bits(*packed);
                                }
                            }
                        }
                    }
                }
                
                instances.push(TransformedInstance {
                    object_id: *obj_id,
                    layer_id: layer_id.clone(),
                    original_layer_id: layer_id, // Same for undo/redo (already committed)
                    x: *x,
                    y: *y,
                    packed_rot_vis: *packed,
                    shape_idx,
                    instance_idx,
                });
            }
        }
    }
    
    instances
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_unpack_rotation() {
        let test_angles = [0.0, std::f32::consts::FRAC_PI_2, std::f32::consts::PI, 1.5 * std::f32::consts::PI];
        for angle in test_angles {
            let packed = pack_rotation_vis(angle, true, false);
            let unpacked = unpack_rotation(packed);
            assert!((unpacked - angle).abs() < 0.001, "Angle {} unpacked to {}", angle, unpacked);
        }
    }
    
    #[test]
    fn test_visibility_flags() {
        let packed = pack_rotation_vis(0.0, true, false);
        assert_eq!(packed & 1, 1); // visible
        assert_eq!(packed & 2, 0); // not moving
        
        let packed = pack_rotation_vis(0.0, true, true);
        assert_eq!(packed & 1, 1); // visible
        assert_eq!(packed & 2, 2); // moving
    }
}

//! Pad geometry generation with instanced rendering
//!
//! Generates instanced geometry for pads (SMD and through-hole) grouped by shape.
//! Uses rotation-aware instancing for efficient GPU rendering.

use std::collections::HashMap;
use crate::draw::geometry::*;
use crate::draw::tessellation::*;

/// Generate instanced_rot geometry for pads (shapes with rotation)
/// Creates 3 LOD levels, each containing multiple geometries for different pad shapes
pub fn generate_pad_geometry(
    layer_id: &str,
    layer_index: u32,
    pads: &[PadInstance],
    primitives: &HashMap<String, StandardPrimitive>,
    object_ranges: &mut Vec<ObjectRange>,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    if pads.is_empty() {
        return Ok(Vec::new());
    }
    
    if std::env::var("DEBUG_PADS").is_ok() {
        eprintln!("  Generating pad geometry for {} pads", pads.len());
    }
    
    // Group pads by shape_id for efficient instancing
    let mut shape_groups: HashMap<String, Vec<(usize, &PadInstance)>> = HashMap::new();
    for (i, pad) in pads.iter().enumerate() {
        shape_groups.entry(pad.shape_id.clone())
            .or_default()
            .push((i, pad));
    }
    
    if std::env::var("DEBUG_PADS").is_ok() {
        eprintln!("  Pad shape groups: {}", shape_groups.len());
    }
    
    let mut lod0_entries = Vec::new();
    let mut lod1_entries = Vec::new();
    let mut lod2_entries = Vec::new();
    let mut shape_index_counter: u32 = 0;
    
    for (shape_id, instances) in shape_groups {
        if let Some(primitive) = primitives.get(&shape_id) {
            if std::env::var("DEBUG_PADS").is_ok() {
                eprintln!("    Shape {}: {} instances, primitive: {:?}", shape_id, instances.len(), primitive);
            }
            
            // Tessellate the base shape once
            let (shape_verts, shape_indices) = tessellate_primitive(primitive);
            
            // Calculate primitive bounds
            let mut prim_min_x = f32::MAX;
            let mut prim_min_y = f32::MAX;
            let mut prim_max_x = f32::MIN;
            let mut prim_max_y = f32::MIN;
            for i in 0..(shape_verts.len()/2) {
                let x = shape_verts[i*2];
                let y = shape_verts[i*2+1];
                prim_min_x = prim_min_x.min(x);
                prim_min_y = prim_min_y.min(y);
                prim_max_x = prim_max_x.max(x);
                prim_max_y = prim_max_y.max(y);
            }
            let prim_w = prim_max_x - prim_min_x;
            let prim_h = prim_max_y - prim_min_y;
            let radius = (prim_w.max(prim_h) / 2.0) * 1.414; // Rough bounding circle radius

            // Create instance data (x, y, rotation) for each pad
            let mut instance_data = Vec::new();
            
            // shape_index tells us which LOD entry this pad belongs to
            let current_shape_index = shape_index_counter;
            
            for (local_idx, (original_idx, inst)) in instances.iter().enumerate() {
                instance_data.push(inst.x);
                instance_data.push(inst.y);
                // Pack rotation and visibility (true)
                instance_data.push(pack_rotation_visibility(inst.rotation.to_radians(), true));
                
                let id = ((layer_index as u64) << 40) | ((3u64) << 36) | (*original_idx as u64);
                
                // Calculate bounds (approximate with bounding circle)
                let min_x = inst.x - radius;
                let min_y = inst.y - radius;
                let max_x = inst.x + radius;
                let max_y = inst.y + radius;
                
                object_ranges.push(ObjectRange {
                    id,
                    layer_id: layer_id.to_string(),
                    obj_type: 3, // Pad
                    vertex_ranges: Vec::new(), // Not used for instanced
                    instance_index: Some(local_idx as u32), // Index within this shape group
                    shape_index: Some(current_shape_index), // Which shape/LOD entry group
                    bounds: [min_x, min_y, max_x, max_y],
                    net_name: inst.net_name.clone(),
                    component_ref: inst.component_ref.clone(),
                    pin_ref: inst.pin_ref.clone(),
                    component_center: None, // Calculated in post-processing
                    polar_radius: None,
                    polar_angle: None,
                });
            }
            
            shape_index_counter += 1;
            
            let vert_count = shape_verts.len() / 2;
            let idx_count = shape_indices.len();
            let inst_count = instance_data.len() / 3; // 3 floats per instance
            
            // For pads, show at all LOD levels (they're always visible)
            // LOD0: Full detail
            lod0_entries.push(GeometryLOD {
                vertex_data: shape_verts.clone(),
                vertex_count: vert_count,
                index_data: Some(shape_indices.clone()),
                index_count: Some(idx_count),
                alpha_data: None,
                visibility_data: None, // Packed in instance data
                instance_data: Some(instance_data.clone()),
                instance_count: Some(inst_count),
            });
            
            // LOD1: Same detail (pads are important)
            lod1_entries.push(GeometryLOD {
                vertex_data: shape_verts.clone(),
                vertex_count: vert_count,
                index_data: Some(shape_indices.clone()),
                index_count: Some(idx_count),
                alpha_data: None,
                visibility_data: None,
                instance_data: Some(instance_data.clone()),
                instance_count: Some(inst_count),
            });
            
            // LOD2: Same detail (pads should remain visible when zoomed out)
            lod2_entries.push(GeometryLOD {
                vertex_data: shape_verts,
                vertex_count: vert_count,
                index_data: Some(shape_indices),
                index_count: Some(idx_count),
                alpha_data: None,
                visibility_data: None,
                instance_data: Some(instance_data),
                instance_count: Some(inst_count),
            });
        } else {
            // Primitive not found - this is a bug!
            eprintln!("  WARNING: Pad shape '{}' not found in primitives! {} instances lost.", shape_id, instances.len());
        }
    }
    
    // Organize as: all LOD0 entries, then all LOD1 entries, then all LOD2 entries
    let mut all_lods = Vec::new();
    all_lods.extend(lod0_entries);
    all_lods.extend(lod1_entries);
    all_lods.extend(lod2_entries);
    
    if std::env::var("DEBUG_PADS").is_ok() {
        eprintln!("  Generated {} total pad LOD entries ({} shapes x 3 LODs)", all_lods.len(), all_lods.len() / 3);
    }
    
    Ok(all_lods)
}

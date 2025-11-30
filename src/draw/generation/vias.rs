//! Via geometry generation with instanced rendering
//!
//! Generates instanced geometry for vias with shape-based grouping and LOD support.
//! Handles annular rings (with holes) for zoomed-in views and solid shapes for LOD.

use std::collections::HashMap;
use crate::draw::geometry::*;
use crate::draw::tessellation::*;

/// Pack rotation and visibility into a single float value
fn pack_rotation_visibility(rotation: f32, visible: bool) -> f32 {
    if visible {
        rotation
    } else {
        -rotation - 100.0
    }
}

/// Via shape key for grouping vias by shape type and dimensions
#[derive(Debug, Hash, Eq, PartialEq)]
enum ShapeKey {
    Circle { diameter_key: String, hole_key: String },
    Rectangle { width_key: String, height_key: String, hole_key: String },
    Oval { width_key: String, height_key: String, hole_key: String },
}

/// Generate instanced geometry for vias with shape and size-based LOD
pub fn generate_via_geometry(
    layer_id: &str,
    layer_index: u32,
    vias: &[ViaInstance],
    object_ranges: &mut Vec<ObjectRange>,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    if vias.is_empty() {
        return Ok(Vec::new());
    }
    
    // Group vias by shape type and size
    let mut shape_groups: HashMap<ShapeKey, Vec<(usize, &ViaInstance)>> = HashMap::new();
    for (i, via) in vias.iter().enumerate() {
        let hole_key = format!("{:.4}", via.hole_diameter);
        let key = match &via.shape {
            StandardPrimitive::Circle { diameter } => {
                ShapeKey::Circle {
                    diameter_key: format!("{:.4}", diameter),
                    hole_key,
                }
            }
            StandardPrimitive::Rectangle { width, height } => {
                ShapeKey::Rectangle {
                    width_key: format!("{:.4}", width),
                    height_key: format!("{:.4}", height),
                    hole_key,
                }
            }
            StandardPrimitive::Oval { width, height } => {
                ShapeKey::Oval {
                    width_key: format!("{:.4}", width),
                    height_key: format!("{:.4}", height),
                    hole_key,
                }
            }
            StandardPrimitive::RoundRect { width, height, .. } => {
                ShapeKey::Rectangle {
                    width_key: format!("{:.4}", width),
                    height_key: format!("{:.4}", height),
                    hole_key,
                }
            }
            StandardPrimitive::CustomPolygon { points } => {
                // Use bounding box for grouping
                let mut min_x = f32::MAX;
                let mut max_x = f32::MIN;
                let mut min_y = f32::MAX;
                let mut max_y = f32::MIN;
                for p in points {
                    min_x = min_x.min(p.x);
                    max_x = max_x.max(p.x);
                    min_y = min_y.min(p.y);
                    max_y = max_y.max(p.y);
                }
                ShapeKey::Rectangle {
                    width_key: format!("{:.4}", max_x - min_x),
                    height_key: format!("{:.4}", max_y - min_y),
                    hole_key,
                }
            }
        };
        shape_groups.entry(key)
            .or_insert_with(Vec::new)
            .push((i, via));
    }
    
    let mut lod0_entries = Vec::new();
    let mut lod1_entries = Vec::new();
    let mut lod2_entries = Vec::new();
    let mut shape_index_counter: u32 = 0;
    
    for (shape_key, instances) in shape_groups {
        if let Some((_, first_via)) = instances.first() {
            let hole_radius = first_via.hole_diameter / 2.0;
            
            if std::env::var("DEBUG_VIA").is_ok() {
                eprintln!("  Via shape {:?}: {} instances", shape_key, instances.len());
            }
            
            // Track the shape index for this group
            let current_shape_index = shape_index_counter;
            
            // Create instance data (x, y) for this shape group
            let mut instance_data = Vec::new();
            for (local_idx, (original_idx, inst)) in instances.iter().enumerate() {
                instance_data.push(inst.x);
                instance_data.push(inst.y);
                // Pack visibility (rotation 0)
                instance_data.push(pack_rotation_visibility(0.0, true));
                
                let id = ((layer_index as u64) << 40) | ((2u64) << 36) | (*original_idx as u64);
                
                // Calculate bounds
                let radius = first_via.diameter / 2.0; // Approx
                let min_x = inst.x - radius;
                let min_y = inst.y - radius;
                let max_x = inst.x + radius;
                let max_y = inst.y + radius;
                
                object_ranges.push(ObjectRange {
                    id,
                    layer_id: layer_id.to_string(),
                    obj_type: 2, // Via
                    vertex_ranges: Vec::new(),
                    instance_index: Some(local_idx as u32),
                    shape_index: Some(current_shape_index),
                    bounds: [min_x, min_y, max_x, max_y],
                    net_name: inst.net_name.clone(),
                    component_ref: inst.component_ref.clone(),
                    pin_ref: None,
                });
            }
            
            shape_index_counter += 1;
            let inst_count = instances.len();
            
            // Tessellate geometry based on shape
            let (with_hole_verts, with_hole_indices, without_hole_verts, without_hole_indices, max_dimension) = 
                tessellate_via_shape(first_via, hole_radius);
            
            let with_hole_vert_count = with_hole_verts.len() / 2;
            let with_hole_idx_count = with_hole_indices.len();
            let without_hole_vert_count = without_hole_verts.len() / 2;
            let without_hole_idx_count = without_hole_indices.len();
            
            // Pixel-density based LOD assignment
            let pixels_at_lod0 = max_dimension * 100.0 * 10.0;
            let pixels_at_lod1 = max_dimension * 100.0 * 5.0;
            let pixels_at_lod2 = max_dimension * 100.0 * 2.0;
            
            let needs_hole_at_lod0 = pixels_at_lod0 >= 150.0;
            let needs_hole_at_lod1 = pixels_at_lod1 >= 400.0;
            let needs_shape_at_lod1 = pixels_at_lod1 >= 50.0;
            let needs_shape_at_lod2 = pixels_at_lod2 >= 30.0;
            
            if std::env::var("DEBUG_VIA").is_ok() {
                eprintln!("    Pixels: LOD0={:.1}px, LOD1={:.1}px, LOD2={:.1}px", 
                    pixels_at_lod0, pixels_at_lod1, pixels_at_lod2);
            }
            
            // LOD0: Show with hole if large enough
            lod0_entries.push(create_via_lod_entry(
                needs_hole_at_lod0,
                &with_hole_verts, with_hole_vert_count, &with_hole_indices, with_hole_idx_count,
                &instance_data, inst_count,
            ));
            
            // LOD1: Show with hole if very large, otherwise solid shape
            if needs_hole_at_lod1 {
                lod1_entries.push(GeometryLOD {
                    vertex_data: with_hole_verts,
                    vertex_count: with_hole_vert_count,
                    index_data: Some(with_hole_indices),
                    index_count: Some(with_hole_idx_count),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(instance_data.clone()),
                    instance_count: Some(inst_count),
                });
            } else if needs_shape_at_lod1 {
                lod1_entries.push(GeometryLOD {
                    vertex_data: without_hole_verts.clone(),
                    vertex_count: without_hole_vert_count,
                    index_data: Some(without_hole_indices.clone()),
                    index_count: Some(without_hole_idx_count),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(instance_data.clone()),
                    instance_count: Some(inst_count),
                });
            } else {
                lod1_entries.push(create_empty_lod_entry());
            }
            
            // LOD2: Show solid shape only if large enough
            if needs_shape_at_lod2 {
                lod2_entries.push(GeometryLOD {
                    vertex_data: without_hole_verts,
                    vertex_count: without_hole_vert_count,
                    index_data: Some(without_hole_indices),
                    index_count: Some(without_hole_idx_count),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(instance_data.clone()),
                    instance_count: Some(inst_count),
                });
            } else {
                lod2_entries.push(create_empty_lod_entry());
            }
        }
    }
    
    // Organize as: all LOD0 entries, then all LOD1 entries, then all LOD2 entries
    let mut all_lods = Vec::new();
    all_lods.extend(lod0_entries);
    all_lods.extend(lod1_entries);
    all_lods.extend(lod2_entries);
    
    Ok(all_lods)
}

/// Tessellate a via shape with and without hole variants
fn tessellate_via_shape(
    via: &ViaInstance,
    hole_radius: f32,
) -> (Vec<f32>, Vec<u32>, Vec<f32>, Vec<u32>, f32) {
    // Ensure minimum visible annular ring width (~0.05mm or 5% of radius, whichever is larger)
    // This makes NPTH drill markers appear as thin rings rather than invisible or solid dots
    match &via.shape {
        StandardPrimitive::Circle { diameter } => {
            let radius = diameter / 2.0;
            let circle = tessellate_circle(radius);
            // Ensure minimum ring width: at least 0.05mm or 5% of radius
            let min_ring_width = (0.05_f32).max(radius * 0.05);
            let effective_hole_radius = hole_radius.min(radius - min_ring_width).max(0.0);
            let ring = tessellate_annular_ring(radius, effective_hole_radius);
            (ring.0, ring.1, circle.0, circle.1, *diameter)
        }
        StandardPrimitive::Rectangle { width, height } => {
            let rect = tessellate_rectangle(*width, *height);
            let min_dim = width.min(*height);
            let min_ring_width = (0.05_f32).max(min_dim * 0.025);
            let effective_hole_radius = hole_radius.min(min_dim / 2.0 - min_ring_width).max(0.0);
            let ring = tessellate_rectangular_ring(*width, *height, effective_hole_radius);
            (ring.0, ring.1, rect.0, rect.1, width.max(*height))
        }
        StandardPrimitive::Oval { width, height } => {
            // For ovals, use simplified approach: oval shape with circular hole
            // TODO: Proper oval ring tessellation
            let oval = tessellate_oval(*width, *height);
            (oval.0.clone(), oval.1.clone(), oval.0, oval.1, width.max(*height))
        }
        StandardPrimitive::RoundRect { width, height, corner_radius } => {
            let roundrect = tessellate_roundrect(*width, *height, *corner_radius);
            let min_dim = width.min(*height);
            let min_ring_width = (0.05_f32).max(min_dim * 0.025);
            let effective_hole_radius = hole_radius.min(min_dim / 2.0 - min_ring_width).max(0.0);
            let ring = tessellate_rectangular_ring(*width, *height, effective_hole_radius);
            (ring.0, ring.1, roundrect.0, roundrect.1, width.max(*height))
        }
        StandardPrimitive::CustomPolygon { points } => {
            // Custom polygons: tessellate without hole (simplified)
            let poly = tessellate_custom_polygon(points);
            let mut max_dim = 0.0f32;
            for p in points {
                max_dim = max_dim.max(p.x.abs()).max(p.y.abs());
            }
            (poly.0.clone(), poly.1.clone(), poly.0, poly.1, max_dim * 2.0)
        }
    }
}

/// Create a LOD entry for vias
fn create_via_lod_entry(
    include_geometry: bool,
    verts: &[f32],
    vert_count: usize,
    indices: &[u32],
    idx_count: usize,
    instance_data: &[f32],
    inst_count: usize,
) -> GeometryLOD {
    if include_geometry {
        GeometryLOD {
            vertex_data: verts.to_vec(),
            vertex_count: vert_count,
            index_data: Some(indices.to_vec()),
            index_count: Some(idx_count),
            alpha_data: None,
            visibility_data: None,
            instance_data: Some(instance_data.to_vec()),
            instance_count: Some(inst_count),
        }
    } else {
        create_empty_lod_entry()
    }
}

/// Create an empty LOD entry (for culled geometry)
fn create_empty_lod_entry() -> GeometryLOD {
    GeometryLOD {
        vertex_data: Vec::new(),
        vertex_count: 0,
        index_data: Some(Vec::new()),
        index_count: Some(0),
        alpha_data: None,
        visibility_data: None,
        instance_data: Some(Vec::new()),
        instance_count: Some(0),
    }
}

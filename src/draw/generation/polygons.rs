//! Polygon geometry generation using earcut triangulation
//!
//! Generates polygon geometry from polygon outlines with holes using tessellation.
//! Polygons are rendered as filled triangles with per-vertex alpha support.

use crate::draw::geometry::*;
use crate::draw::tessellation::tessellate_polygon;
use rayon::prelude::*;

/// Generate polygon LOD geometry using earcut triangulation
pub fn generate_polygon_geometry(
    layer_id: &str,
    layer_index: u32,
    polygons: &[Polygon],
    object_ranges: &mut Vec<ObjectRange>,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    // Use rayon to tessellate polygons in parallel
    let results: Vec<(Vec<f32>, Vec<u32>)> = polygons.par_iter()
        .map(|polygon| tessellate_polygon(polygon, 0.0)) // LOD0: no simplification
        .collect();
        
    let mut all_verts = Vec::new();
    let mut all_indices = Vec::new();
    let mut alpha_values = Vec::new();
    let mut visibility_values = Vec::new();

    let _start_obj_idx = object_ranges.len();

    // Combine results sequentially
    for (i, (verts, indices)) in results.into_iter().enumerate() {
        let polygon = &polygons[i];
        let vert_count = verts.len() / 2;
        
        // Generate ID and bounds
        let id = ((layer_index as u64) << 40) | ((1u64) << 36) | (i as u64);
        
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        
        for p in &polygon.outer_ring {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
        
        let current_vert_start = (all_verts.len() / 2) as u32;
        
        object_ranges.push(ObjectRange {
            id,
            layer_id: layer_id.to_string(),
            obj_type: 1, // Polygon
            vertex_ranges: vec![(current_vert_start, vert_count as u32); 5], // Same for all LODs (simplified)
            instance_index: None,
            shape_index: None, // Not used for batched geometry
            bounds: [min_x, min_y, max_x, max_y],
            net_name: polygon.net_name.clone(),
            component_ref: polygon.component_ref.clone(),
            pin_ref: None,
            component_center: None,
            polar_radius: None,
            polar_angle: None,
        });

        // Offset indices by current vertex count
        let vert_offset = (all_verts.len() / 2) as u32;
        all_verts.extend(verts);
        all_indices.extend(indices.iter().map(|&idx| idx + vert_offset));
        
        // Add alpha values
        let alpha = polygon.fill_color[3];
        alpha_values.extend(std::iter::repeat_n(alpha, vert_count));
        
        // Add visibility values
        visibility_values.extend(std::iter::repeat_n(1.0, vert_count));
    }
    
    if all_verts.is_empty() || all_indices.is_empty() {
        return Ok(Vec::new());
    }
    
    let vert_count = all_verts.len() / 2;
    let index_count = all_indices.len();
    
    let geometry_lod = GeometryLOD {
        vertex_data: all_verts,
        vertex_count: vert_count,
        index_data: Some(all_indices),
        index_count: Some(index_count),
        alpha_data: Some(alpha_values),
        visibility_data: Some(visibility_values),
        instance_data: None,
        instance_count: None,
    };
    
    Ok(vec![geometry_lod])
}

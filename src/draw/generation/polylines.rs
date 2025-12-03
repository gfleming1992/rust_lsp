//! Polyline geometry generation with LOD support
//!
//! Generates batched polyline geometry with 5 LOD levels using Douglas-Peucker
//! simplification and width-based visibility culling.

use crate::draw::geometry::*;
use crate::draw::tessellation::*;
use rayon::prelude::*;

use super::{should_debug_layer, debug_print_polyline};

/// Generate polyline LOD geometry
pub fn generate_polyline_geometry(
    layer_id: &str,
    layer_index: u32,
    layer_name: &str,
    polylines: &[Polyline],
    culling_stats: &mut CullingStats,
    object_ranges: &mut Vec<ObjectRange>,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    let mut lod_geometries: Vec<GeometryLOD> = Vec::new();

    // Generate LODs for all polylines
    let lod_gen_start = std::time::Instant::now();
    
    // Use rayon to generate LODs in parallel
    let all_lod_points: Vec<Vec<Vec<Point>>> = polylines.par_iter()
        .map(generate_polyline_lods)
        .collect();
        
    let lod_gen_time = lod_gen_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] LOD generation: {:.2}ms ({} polylines)",
                 layer_name, lod_gen_time.as_secs_f64() * 1000.0, polylines.len());
    }

    // Initialize object ranges for polylines
    let start_obj_idx = object_ranges.len();
    for (i, polyline) in polylines.iter().enumerate() {
        let id = ((layer_index as u64) << 40) | ((0u64) << 36) | (i as u64);
        
        // Calculate bounds
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        
        for p in &polyline.points {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
        // Expand by width/2
        let half_width = polyline.width / 2.0;
        min_x -= half_width;
        min_y -= half_width;
        max_x += half_width;
        max_y += half_width;
        
        object_ranges.push(ObjectRange {
            id,
            layer_id: layer_id.to_string(),
            obj_type: 0, // Polyline
            vertex_ranges: vec![(0, 0); 5], // Will be filled per LOD
            instance_index: None,
            shape_index: None,
            bounds: [min_x, min_y, max_x, max_y],
            net_name: polyline.net_name.clone(),
            component_ref: polyline.component_ref.clone(),
            pin_ref: None,
        });
    }

    // For each LOD level, batch all polylines at that LOD
    let batch_start = std::time::Instant::now();
    let debug_this_layer = should_debug_layer(layer_id);
    let mut debug_header_printed = false;
    culling_stats.total_polylines += polylines.len();
    
    for lod_idx in 0..5 {
        let mut lod_polylines_data = Vec::new();
        let mut poly_indices_in_batch = Vec::new();
        let min_width = MIN_VISIBLE_WIDTH_LOD[lod_idx];
        
        for (poly_idx, polyline) in polylines.iter().enumerate() {
            if poly_idx < all_lod_points.len() && lod_idx < all_lod_points[poly_idx].len() {
                // Skip tessellation if line is too thin to be visible at this LOD
                if polyline.width < min_width {
                    culling_stats.lod_culled[lod_idx] += 1;
                    object_ranges[start_obj_idx + poly_idx].vertex_ranges[lod_idx] = (0, 0);
                    continue;
                }
                
                // Width-dependent LOD cap optimization
                let butt_lod_threshold = if polyline.width < 0.05 {
                    1
                } else if polyline.width < 0.2 {
                    2
                } else {
                    3
                };
                
                let effective_line_end = if lod_idx >= butt_lod_threshold && polyline.line_end != LineEnd::Butt {
                    LineEnd::Butt
                } else {
                    polyline.line_end
                };
                
                let lod_points = all_lod_points[poly_idx][lod_idx].clone();
                if debug_this_layer && lod_idx == 0 {
                    if !debug_header_printed {
                        eprintln!(
                            "\n=== {} Polyline Tessellation (first 200 triangles) ===",
                            layer_name
                        );
                        eprintln!(" Total {} polylines: {}", layer_name, polylines.len());
                        debug_header_printed = true;
                    }
                    debug_print_polyline(layer_id, &lod_points, polyline.width, effective_line_end);
                }
                lod_polylines_data.push((lod_points, polyline.width, effective_line_end));
                poly_indices_in_batch.push(poly_idx);
            }
        }

        if lod_polylines_data.is_empty() {
            continue;
        }

        // Batch all polylines at this LOD into single vertex/index buffer
        let tessellate_start = std::time::Instant::now();
        let (verts, indices, vertex_counts) = batch_polylines_with_styles(&lod_polylines_data);
        let tessellate_time = tessellate_start.elapsed();
        
        if std::env::var("PROFILE_TIMING").is_ok() && !lod_polylines_data.is_empty() {
            eprintln!("      LOD{}: tessellation {:.2}ms ({} polylines -> {} verts, {} indices)",
                     lod_idx, tessellate_time.as_secs_f64() * 1000.0,
                     lod_polylines_data.len(), verts.len() / 2, indices.len());
        }

        if verts.is_empty() || indices.is_empty() {
            continue;
        }

        // Populate vertex_ranges for each polyline in this LOD
        let mut current_vert_offset = 0;
        for (batch_idx, &poly_idx) in poly_indices_in_batch.iter().enumerate() {
            let vert_count = vertex_counts[batch_idx];
            object_ranges[start_obj_idx + poly_idx].vertex_ranges[lod_idx] = (current_vert_offset as u32, vert_count as u32);
            current_vert_offset += vert_count;
        }

        let vertex_count = verts.len() / 2;
        let index_count = indices.len();
        
        // Create visibility data (all 1.0)
        let visibility_data = vec![1.0; vertex_count];
        
        let geometry_lod = GeometryLOD {
            vertex_data: verts,
            vertex_count,
            index_data: Some(indices),
            index_count: Some(index_count),
            alpha_data: None,
            visibility_data: Some(visibility_data),
            instance_data: None,
            instance_count: None,
        };

        lod_geometries.push(geometry_lod);
    }

    if debug_this_layer && debug_header_printed {
        eprintln!("=== End of {} Tessellation (200 triangles shown) ===", layer_name);
        let total = polylines.len();
        for (lod, count) in culling_stats.lod_culled.iter().enumerate() {
            if *count > 0 {
                eprintln!("  LOD{}: culled {}/{} polylines (width < {:.3})",
                    lod, count, total, MIN_VISIBLE_WIDTH_LOD[lod]);
            }
        }
    }

    let batch_time = batch_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] Batching/tessellation: {:.2}ms", layer_name, batch_time.as_secs_f64() * 1000.0);
    }
    
    Ok(lod_geometries)
}

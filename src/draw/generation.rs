use crate::draw::geometry::*;
use crate::draw::tessellation::*;
use rayon::prelude::*;
use std::collections::HashMap;
use std::env;

fn should_debug_layer(layer_id: &str) -> bool {
    match env::var("DEBUG_TESSELLATION_LAYER") {
        Ok(val) => {
            if val.trim().is_empty() {
                true
            } else {
                val.split(',').any(|entry| entry.trim() == layer_id)
            }
        }
        Err(_) => false,
    }
}

fn debug_print_polyline(
    layer_id: &str,
    points: &[Point],
    width: f32,
    line_end: LineEnd,
) {
    let (verts, indices) = tessellate_polyline(points, width, line_end);
    eprintln!(
        "\nPolyline: {} points, width: {:.3}, layer: {}",
        points.len(),
        width,
        layer_id
    );
    eprintln!(
        " Generated: {} triangles ({} vertices)",
        indices.len() / 3,
        verts.len() / 2
    );

    let mut vertex_pairs = Vec::with_capacity(verts.len() / 2);
    for chunk in verts.chunks_exact(2) {
        vertex_pairs.push((chunk[0], chunk[1]));
    }

    for (tri_idx, tri) in indices.chunks_exact(3).enumerate() {
        if tri_idx >= 200 {
            break;
        }
        let v0 = vertex_pairs[tri[0] as usize];
        let v1 = vertex_pairs[tri[1] as usize];
        let v2 = vertex_pairs[tri[2] as usize];
        eprintln!(
            " Triangle {}: [{:.3}, {:.3}], [{:.3}, {:.3}], [{:.3}, {:.3}]",
            tri_idx, v0.0, v0.1, v1.0, v1.1, v2.0, v2.1
        );
    }
}

/// Generate LayerJSON for all geometry types (polylines, polygons, pads, vias) in a layer
pub fn generate_layer_json(
    layer_id: &str,
    layer_index: u32, // Added layer_index for ID generation
    layer_name: &str,
    color: [f32; 4],
    geometries: &LayerGeometries,
    culling_stats: &mut CullingStats,
    primitives: &HashMap<String, StandardPrimitive>,
) -> Result<(LayerJSON, Vec<ObjectRange>), anyhow::Error> {
    let layer_start = std::time::Instant::now();
    let mut object_ranges = Vec::new();
    
    // Generate polyline geometry (opaque, no alpha) - for batch.wgsl
    let polyline_lods = if !geometries.polylines.is_empty() {
        generate_polyline_geometry(layer_id, layer_index, layer_name, &geometries.polylines, culling_stats, &mut object_ranges)?
    } else {
        Vec::new()
    };
    
    // Generate polygon geometry (with alpha) - for batch_colored.wgsl
    let polygon_lods = if !geometries.polygons.is_empty() {
        if std::env::var("PROFILE_TIMING").is_ok() {
            eprintln!("    [{}] Processing {} polygons", layer_name, geometries.polygons.len());
        }
        let lods = generate_polygon_geometry(layer_id, layer_index, &geometries.polygons, &mut object_ranges)?;
        if std::env::var("PROFILE_TIMING").is_ok() && !lods.is_empty() {
            eprintln!("    [{}] Generated {} polygon LODs with {} vertices", 
                layer_name, lods.len(), lods[0].vertex_count);
        }
        lods
    } else {
        Vec::new()
    };
    
    // Generate pad geometry (instanced with rotation) - for instanced_rot shader
    let pad_lods = if !geometries.pads.is_empty() {
        if std::env::var("PROFILE_TIMING").is_ok() {
            eprintln!("    [{}] Processing {} pads", layer_name, geometries.pads.len());
        }
        generate_pad_geometry(layer_id, layer_index, &geometries.pads, primitives, &mut object_ranges)?
    } else {
        Vec::new()
    };
    
    // Generate via geometry (instanced without rotation) - for instanced shader
    let via_lods = if !geometries.vias.is_empty() {
        if std::env::var("PROFILE_TIMING").is_ok() {
            eprintln!("    [{}] Processing {} vias", layer_name, geometries.vias.len());
        }
        generate_via_geometry(layer_id, layer_index, &geometries.vias, &mut object_ranges)?
    } else {
        Vec::new()
    };
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] Total layer time: {:.2}ms\n", layer_name, layer_start.elapsed().as_secs_f64() * 1000.0);
    }
    
    let mut shader_geom = ShaderGeometry::default();
    shader_geom.batch = if polyline_lods.is_empty() {
        None
    } else {
        Some(polyline_lods)
    };
    shader_geom.batch_colored = if polygon_lods.is_empty() {
        None
    } else {
        Some(polygon_lods)
    };
    shader_geom.instanced_rot = if pad_lods.is_empty() {
        None
    } else {
        Some(pad_lods)
    };
    shader_geom.instanced = if via_lods.is_empty() {
        None
    } else {
        Some(via_lods)
    };
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] ShaderGeometry: batch={}, batch_colored={}, instanced_rot={}, instanced={}", 
            layer_name, 
            shader_geom.batch.is_some(),
            shader_geom.batch_colored.is_some(),
            shader_geom.instanced_rot.is_some(),
            shader_geom.instanced.is_some());
        
        // Debug: serialize and check JSON output
        if let Ok(json_str) = serde_json::to_string(&shader_geom) {
            let has_batch_colored = json_str.contains("batch_colored");
            let has_instanced_rot = json_str.contains("instanced_rot");
            eprintln!("    [{}] JSON contains batch_colored: {}, instanced_rot: {}", layer_name, has_batch_colored, has_instanced_rot);
            if !has_batch_colored && shader_geom.batch_colored.is_some() {
                eprintln!("    [{}] WARNING: batch_colored is Some but not in JSON!", layer_name);
            }
            if !has_instanced_rot && shader_geom.instanced_rot.is_some() {
                eprintln!("    [{}] WARNING: instanced_rot is Some but not in JSON!", layer_name);
            }
        }
    }

    Ok((LayerJSON {
        layer_id: layer_id.to_string(),
        layer_name: layer_name.to_string(),
        default_color: color,
        geometry: shader_geom,
    }, object_ranges))
}

/// Generate polyline LOD geometry (extracted from original generate_layer_json)
fn generate_polyline_geometry(
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
        .map(|polyline| generate_polyline_lods(polyline))
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
            bounds: [min_x, min_y, max_x, max_y],
            net_name: polyline.net_name.clone(),
        });
    }

    // For each LOD level, batch all polylines at that LOD
    let batch_start = std::time::Instant::now();
    let debug_this_layer = should_debug_layer(layer_id);
    let mut debug_header_printed = false;
    culling_stats.total_polylines += polylines.len();
    
    for lod_idx in 0..5 {
        let mut lod_polylines_data = Vec::new();
        let mut poly_indices_in_batch = Vec::new(); // Track which polyline index each entry corresponds to
        let min_width = MIN_VISIBLE_WIDTH_LOD[lod_idx];
        
        for (poly_idx, polyline) in polylines.iter().enumerate() {
            if poly_idx < all_lod_points.len() && lod_idx < all_lod_points[poly_idx].len() {
                // Skip tessellation if line is too thin to be visible at this LOD
                if polyline.width < min_width {
                    culling_stats.lod_culled[lod_idx] += 1;
                    // Update range to 0 count
                    object_ranges[start_obj_idx + poly_idx].vertex_ranges[lod_idx] = (0, 0);
                    continue;
                }
                
                // Width-dependent LOD cap optimization:
                // - Thin lines (< 0.05): butt caps from LOD 1+
                // - Medium lines (0.05-0.2): butt caps from LOD 2+
                // - Thick lines (> 0.2): butt caps from LOD 3+
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
                        eprintln!(
                            " Total {} polylines: {}",
                            layer_name,
                            polylines.len()
                        );
                        debug_header_printed = true;
                    }
                    debug_print_polyline(
                        layer_id,
                        &lod_points,
                        polyline.width,
                        effective_line_end,
                    );
                }
                lod_polylines_data.push((lod_points, polyline.width, effective_line_end));
                poly_indices_in_batch.push(poly_idx); // Track which polyline this is
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
            alpha_data: None, // Will be added later in generate_layer_json
            visibility_data: Some(visibility_data),
            instance_data: None,
            instance_count: None,
        };

        lod_geometries.push(geometry_lod);
    }

    if debug_this_layer && debug_header_printed {
        eprintln!(
            "=== End of {} Tessellation (200 triangles shown) ===",
            layer_name
        );
        // Report culling stats
        let total = polylines.len();
        for (lod, count) in culling_stats.lod_culled.iter().enumerate() {
            if *count > 0 {
                eprintln!(
                    "  LOD{}: culled {}/{} polylines (width < {:.3})",
                    lod, count, total, MIN_VISIBLE_WIDTH_LOD[lod]
                );
            }
        }
    }

    let batch_time = batch_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] Batching/tessellation: {:.2}ms", layer_name, batch_time.as_secs_f64() * 1000.0);
    }
    
    Ok(lod_geometries)
}

/// Generate polygon LOD geometry using earcut triangulation
fn generate_polygon_geometry(
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
            bounds: [min_x, min_y, max_x, max_y],
            net_name: polygon.net_name.clone(),
        });

        // Offset indices by current vertex count
        let vert_offset = (all_verts.len() / 2) as u32;
        all_verts.extend(verts);
        all_indices.extend(indices.iter().map(|&idx| idx + vert_offset));
        
        // Add alpha values
        let alpha = polygon.fill_color[3];
        alpha_values.extend(std::iter::repeat(alpha).take(vert_count));
        
        // Add visibility values
        visibility_values.extend(std::iter::repeat(1.0).take(vert_count));
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

/// Generate instanced_rot geometry for pads (shapes with rotation)
/// Creates 3 LOD levels, each containing multiple geometries for different pad shapes
fn generate_pad_geometry(
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
            .or_insert_with(Vec::new)
            .push((i, pad));
    }
    
    if std::env::var("DEBUG_PADS").is_ok() {
        eprintln!("  Pad shape groups: {}", shape_groups.len());
    }
    
    let mut lod0_entries = Vec::new();
    let mut lod1_entries = Vec::new();
    let mut lod2_entries = Vec::new();
    
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
            // This is per-LOD-entry index, but we need global tracking?
            // Actually, instance_index in ObjectRange refers to the index within the specific draw call (LOD entry)
            // But since we have multiple LOD entries per LOD level (one per shape), this is complex.
            // Wait, the frontend renders each LOD entry separately.
            // So instance_index should be relative to that LOD entry.
            // But we need to know WHICH LOD entry an object belongs to.
            // My ObjectRange struct assumes 1 draw call per LOD level for batched, but instanced has multiple.
            // I need to update ObjectRange to handle this or simplify.
            // For now, let's assume we can map back.
            
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
                    bounds: [min_x, min_y, max_x, max_y],
                    net_name: inst.net_name.clone(),
                });
                // Note: This pushes duplicate ObjectRanges if we iterate multiple times?
                // No, we iterate shape groups once.
                // But wait, we generate 3 LODs.
                // The instance index is the same for all 3 LODs because we push the same instance_data.
                // So one ObjectRange is enough.
            }
            
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
        } 
        // ...existing code...
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

/// Generate instanced geometry for vias with shape and size-based LOD
fn generate_via_geometry(
    layer_id: &str,
    layer_index: u32,
    vias: &[ViaInstance],
    object_ranges: &mut Vec<ObjectRange>,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    if vias.is_empty() {
        return Ok(Vec::new());
    }
    
    // Group vias by shape type and size
    #[derive(Debug, Hash, Eq, PartialEq)]
    enum ShapeKey {
        Circle { diameter_key: String, hole_key: String },
        Rectangle { width_key: String, height_key: String, hole_key: String },
        Oval { width_key: String, height_key: String, hole_key: String },
    }
    
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
    
    for (shape_key, instances) in shape_groups {
        if let Some((_, first_via)) = instances.first() {
            let hole_radius = first_via.hole_diameter / 2.0;
            
            if std::env::var("DEBUG_VIA").is_ok() {
                eprintln!("  Via shape {:?}: {} instances", shape_key, instances.len());
            }
            
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
                    bounds: [min_x, min_y, max_x, max_y],
                    net_name: inst.net_name.clone(),
                });
            }
            let inst_count = instances.len();
            
            // Tessellate geometry based on shape
            let (with_hole_verts, with_hole_indices, without_hole_verts, without_hole_indices, max_dimension) = match &first_via.shape {
                StandardPrimitive::Circle { diameter } => {
                    let radius = diameter / 2.0;
                    let ring = tessellate_annular_ring(radius, hole_radius);
                    let circle = tessellate_circle(radius);
                    (ring.0, ring.1, circle.0, circle.1, *diameter)
                }
                StandardPrimitive::Rectangle { width, height } => {
                    let ring = tessellate_rectangular_ring(*width, *height, hole_radius);
                    let rect = tessellate_rectangle(*width, *height);
                    (ring.0, ring.1, rect.0, rect.1, width.max(*height))
                }
                StandardPrimitive::Oval { width, height } => {
                    // For ovals, use simplified approach: oval shape with circular hole
                    // TODO: Proper oval ring tessellation
                    let oval = tessellate_oval(*width, *height);
                    (oval.0.clone(), oval.1.clone(), oval.0, oval.1, width.max(*height))
                }
                StandardPrimitive::RoundRect { width, height, corner_radius } => {
                    let roundrect_ring = tessellate_rectangular_ring(*width, *height, hole_radius);
                    let roundrect = tessellate_roundrect(*width, *height, *corner_radius);
                    (roundrect_ring.0, roundrect_ring.1, roundrect.0, roundrect.1, width.max(*height))
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
            };
            
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
            if needs_hole_at_lod0 {
                lod0_entries.push(GeometryLOD {
                    vertex_data: with_hole_verts.clone(),
                    vertex_count: with_hole_vert_count,
                    index_data: Some(with_hole_indices.clone()),
                    index_count: Some(with_hole_idx_count),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(instance_data.clone()),
                    instance_count: Some(inst_count),
                });
            } else {
                lod0_entries.push(GeometryLOD {
                    vertex_data: Vec::new(),
                    vertex_count: 0,
                    index_data: Some(Vec::new()),
                    index_count: Some(0),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(Vec::new()),
                    instance_count: Some(0),
                });
            }
            
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
                lod1_entries.push(GeometryLOD {
                    vertex_data: Vec::new(),
                    vertex_count: 0,
                    index_data: Some(Vec::new()),
                    index_count: Some(0),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(Vec::new()),
                    instance_count: Some(0),
                });
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
                lod2_entries.push(GeometryLOD {
                    vertex_data: Vec::new(),
                    vertex_count: 0,
                    index_data: Some(Vec::new()),
                    index_count: Some(0),
                    alpha_data: None,
                    visibility_data: None,
                    instance_data: Some(Vec::new()),
                    instance_count: Some(0),
                });
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

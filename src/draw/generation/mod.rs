//! Geometry generation module for PCB layers
//!
//! This module converts parsed PCB geometry (polylines, polygons, pads, vias)
//! into GPU-ready tessellated geometry with LOD support.
//!
//! # Submodules
//! - `polylines` - Polyline geometry generation with LOD
//! - `polygons` - Polygon geometry generation
//! - `pads` - Instanced pad geometry generation
//! - `vias` - Instanced via geometry generation

mod polylines;
mod polygons;
mod pads;
mod vias;

use crate::draw::geometry::*;
use crate::draw::tessellation::tessellate_polyline;
use std::collections::HashMap;
use std::env;

pub use polylines::generate_polyline_geometry;
pub use polygons::generate_polygon_geometry;
pub use pads::generate_pad_geometry;
pub use vias::generate_via_geometry;

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

pub(crate) fn debug_print_polyline(
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
#[allow(clippy::too_many_arguments)]
pub fn generate_layer_json(
    layer_id: &str,
    layer_index: u32,
    layer_name: &str,
    layer_function: &str,
    layer_side: &str,
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
    
    let shader_geom = ShaderGeometry {
        batch: if polyline_lods.is_empty() { None } else { Some(polyline_lods) },
        batch_colored: if polygon_lods.is_empty() { None } else { Some(polygon_lods) },
        instanced_rot: if pad_lods.is_empty() { None } else { Some(pad_lods) },
        instanced: if via_lods.is_empty() { None } else { Some(via_lods) },
    };
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("    [{}] ShaderGeometry: batch={}, batch_colored={}, instanced_rot={}, instanced={}", 
            layer_name, 
            shader_geom.batch.is_some(),
            shader_geom.batch_colored.is_some(),
            shader_geom.instanced_rot.is_some(),
            shader_geom.instanced.is_some());
        
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
        layer_function: layer_function.to_string(),
        layer_side: layer_side.to_string(),
        default_color: color,
        geometry: shader_geom,
    }, object_ranges))
}

//! Geometry extraction for DRC
//!
//! Extracts boundary triangles from object geometry for clearance checking.

use crate::draw::geometry::{ObjectRange, LayerJSON, GeometryLOD};
use super::distance::Triangle;
use std::collections::{HashMap, HashSet};

/// Extract boundary triangles from object's LOD0 geometry using edge adjacency
pub fn get_boundary_triangles_for_object(obj: &ObjectRange, layer: &LayerJSON) -> Vec<Triangle> {
    // Determine which geometry array to use based on obj_type
    let (verts, indices, offset, rotation) = match obj.obj_type {
        0 => {
            let (v, i, o) = get_batch_triangles(obj, &layer.geometry.batch);
            (v, i, o, 0.0f32)
        }, // Polyline
        1 => {
            let (v, i, o) = get_batch_triangles(obj, &layer.geometry.batch_colored);
            (v, i, o, 0.0f32)
        }, // Polygon
        2 => {
            let (v, i, o, r) = get_instanced_triangles(obj, &layer.geometry.instanced, false);
            (v, i, o, r)
        }, // Via
        3 => {
            let (v, i, o, r) = get_instanced_triangles(obj, &layer.geometry.instanced_rot, true);
            (v, i, o, r)
        }, // Pad with rotation
        _ => return vec![],
    };

    if verts.is_empty() || indices.is_empty() {
        return vec![];
    }

    extract_boundary_triangles(&verts, &indices, offset, rotation)
}

/// Get vertex/index data from batched geometry (polylines, polygons)
fn get_batch_triangles(
    obj: &ObjectRange,
    geometry: &Option<Vec<GeometryLOD>>,
) -> (Vec<f32>, Vec<u32>, Option<[f32; 2]>) {
    let empty = (vec![], vec![], None);

    let lods = match geometry {
        Some(lods) if !lods.is_empty() => lods,
        _ => return empty,
    };

    // Use LOD0 for full precision
    let lod = &lods[0];

    // Get vertex range for this object
    if obj.vertex_ranges.is_empty() {
        return empty;
    }

    let (start_idx, count) = obj.vertex_ranges[0];
    
    // For batched geometry, we need to extract the triangles for this specific object
    // The vertex_ranges give us the vertex start/count, but indices are global
    // We need to find indices that reference vertices in our range
    
    let indices = match &lod.index_data {
        Some(idx) => idx.clone(),
        None => return empty,
    };

    // Filter indices to only those in our vertex range
    let vertex_end = start_idx + count;
    let filtered_indices: Vec<u32> = indices
        .chunks(3)
        .filter(|chunk| {
            chunk.len() == 3
                && chunk.iter().all(|&i| i >= start_idx && i < vertex_end)
        })
        .flatten()
        .copied()
        .collect();

    (lod.vertex_data.clone(), filtered_indices, None)
}

/// Get vertex/index data from instanced geometry (vias, pads)
/// Returns (vertices, indices, offset, rotation_radians)
fn get_instanced_triangles(
    obj: &ObjectRange,
    geometry: &Option<Vec<GeometryLOD>>,
    has_rotation: bool,
) -> (Vec<f32>, Vec<u32>, Option<[f32; 2]>, f32) {
    let empty = (vec![], vec![], None, 0.0f32);

    let lods = match geometry {
        Some(lods) if !lods.is_empty() => lods,
        _ => return empty,
    };

    // Get the shape LOD for this object
    let shape_idx = obj.shape_index.unwrap_or(0) as usize;
    if shape_idx >= lods.len() {
        return empty;
    }

    let lod = &lods[shape_idx];

    // Get instance position and rotation from instance_data
    let instance_idx = obj.instance_index.unwrap_or(0) as usize;
    let (offset, rotation) = if let Some(ref inst_data) = lod.instance_data {
        let stride = 3; // x, y, packed
        let base = instance_idx * stride;
        if base + 2 < inst_data.len() {
            let x = inst_data[base];
            let y = inst_data[base + 1];
            let packed = inst_data[base + 2];
            
            // Extract rotation from packed data if this is instanced_rot
            let rot = if has_rotation {
                let packed_bits = packed.to_bits();
                let angle_u16 = packed_bits >> 16;
                let angle_normalized = (angle_u16 as f32) / 65535.0;
                angle_normalized * std::f32::consts::TAU // 2 * PI
            } else {
                0.0f32
            };
            
            (Some([x, y]), rot)
        } else if base + 1 < inst_data.len() {
            (Some([inst_data[base], inst_data[base + 1]]), 0.0f32)
        } else {
            (None, 0.0f32)
        }
    } else {
        (None, 0.0f32)
    };

    let indices = match &lod.index_data {
        Some(idx) => idx.clone(),
        None => return empty,
    };

    (lod.vertex_data.clone(), indices, offset, rotation)
}

/// Extract boundary triangles using edge adjacency (topology-based)
/// Applies translation offset and rotation to vertices
fn extract_boundary_triangles(
    verts: &[f32],
    indices: &[u32],
    offset: Option<[f32; 2]>,
    rotation: f32,
) -> Vec<Triangle> {
    let mut edge_count: HashMap<(u32, u32), usize> = HashMap::new();

    // Count edge occurrences
    for chunk in indices.chunks(3) {
        if chunk.len() != 3 {
            continue;
        }
        for &(i, j) in &[
            (chunk[0], chunk[1]),
            (chunk[1], chunk[2]),
            (chunk[2], chunk[0]),
        ] {
            let edge = (i.min(j), i.max(j));
            *edge_count.entry(edge).or_insert(0) += 1;
        }
    }

    // Find boundary edges (count == 1)
    let boundary_edges: HashSet<(u32, u32)> = edge_count
        .into_iter()
        .filter(|(_, count)| *count == 1)
        .map(|(edge, _)| edge)
        .collect();

    let off = offset.unwrap_or([0.0, 0.0]);
    let cos_r = rotation.cos();
    let sin_r = rotation.sin();

    // Helper to apply rotation + translation
    let transform_point = |x: f32, y: f32| -> [f32; 2] {
        // Apply rotation around origin, then translation
        let rx = x * cos_r - y * sin_r;
        let ry = x * sin_r + y * cos_r;
        [rx + off[0], ry + off[1]]
    };

    // Extract triangles that touch boundary edges
    indices
        .chunks(3)
        .filter(|chunk| {
            if chunk.len() != 3 {
                return false;
            }
            // Check if any edge is a boundary edge
            let edges = [
                (chunk[0].min(chunk[1]), chunk[0].max(chunk[1])),
                (chunk[1].min(chunk[2]), chunk[1].max(chunk[2])),
                (chunk[2].min(chunk[0]), chunk[2].max(chunk[0])),
            ];
            edges.iter().any(|e| boundary_edges.contains(e))
        })
        .filter_map(|chunk| {
            let i0 = chunk[0] as usize;
            let i1 = chunk[1] as usize;
            let i2 = chunk[2] as usize;

            // Bounds check
            if i0 * 2 + 1 >= verts.len() || i1 * 2 + 1 >= verts.len() || i2 * 2 + 1 >= verts.len()
            {
                return None;
            }

            Some(Triangle::from_vertices(
                transform_point(verts[i0 * 2], verts[i0 * 2 + 1]),
                transform_point(verts[i1 * 2], verts[i1 * 2 + 1]),
                transform_point(verts[i2 * 2], verts[i2 * 2 + 1]),
            ))
        })
        .collect()
}

//! Region fusion logic for DRC
//!
//! Fuses individual triangle violations into contiguous regions.

use super::types::{TriangleViolation, DrcRegion};
use std::collections::{HashMap, HashSet};

/// Fuse triangle violations into regions based on spatial adjacency
pub fn fuse_violations_into_regions(violations: Vec<TriangleViolation>) -> Vec<DrcRegion> {
    if violations.is_empty() {
        return vec![];
    }

    // Group by (object_a_id, object_b_id) pair - violations between same object pair go to same region
    let mut pair_groups: HashMap<(u64, u64), Vec<TriangleViolation>> = HashMap::new();
    for v in violations {
        let key = (v.object_a_id.min(v.object_b_id), v.object_a_id.max(v.object_b_id));
        pair_groups.entry(key).or_default().push(v);
    }

    let mut regions = Vec::new();
    let mut region_id = 0u32;

    for ((obj_a, obj_b), group) in pair_groups {
        if group.is_empty() {
            continue;
        }

        // For simplicity, treat each object pair as one region
        // (Could further split by spatial disconnection if needed)
        
        // Collect all triangle vertices and compute bounds
        let mut triangle_vertices = Vec::new();
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        let mut min_distance = f32::MAX;
        let mut seen_triangles: HashSet<[u32; 6]> = HashSet::new();

        let first = &group[0];
        let layer_id = first.layer_id.clone();
        let clearance_mm = first.clearance_mm;
        let net_a = first.net_a.clone();
        let net_b = first.net_b.clone();

        for v in &group {
            min_distance = min_distance.min(v.distance_mm);

            // Add triangle A (dedup by quantized vertex positions)
            let key_a = quantize_triangle(&v.tri_a);
            if seen_triangles.insert(key_a) {
                for pt in &v.tri_a {
                    triangle_vertices.push(pt[0]);
                    triangle_vertices.push(pt[1]);
                    min_x = min_x.min(pt[0]);
                    min_y = min_y.min(pt[1]);
                    max_x = max_x.max(pt[0]);
                    max_y = max_y.max(pt[1]);
                }
            }

            // Add triangle B
            let key_b = quantize_triangle(&v.tri_b);
            if seen_triangles.insert(key_b) {
                for pt in &v.tri_b {
                    triangle_vertices.push(pt[0]);
                    triangle_vertices.push(pt[1]);
                    min_x = min_x.min(pt[0]);
                    min_y = min_y.min(pt[1]);
                    max_x = max_x.max(pt[0]);
                    max_y = max_y.max(pt[1]);
                }
            }
        }

        let triangle_count = triangle_vertices.len() / 6; // 6 floats per triangle

        regions.push(DrcRegion {
            id: region_id,
            layer_id,
            min_distance_mm: min_distance,
            clearance_mm,
            net_a,
            net_b,
            bounds: [min_x, min_y, max_x, max_y],
            center: [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0],
            object_ids: vec![obj_a, obj_b],
            triangle_vertices,
            triangle_count,
        });

        region_id += 1;
    }

    regions
}

/// Quantize triangle vertices to integers for deduplication
fn quantize_triangle(tri: &[[f32; 2]; 3]) -> [u32; 6] {
    let scale = 10000.0; // 0.1 micron precision
    [
        (tri[0][0] * scale) as u32,
        (tri[0][1] * scale) as u32,
        (tri[1][0] * scale) as u32,
        (tri[1][1] * scale) as u32,
        (tri[2][0] * scale) as u32,
        (tri[2][1] * scale) as u32,
    ]
}

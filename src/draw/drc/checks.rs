//! Layer clearance checking logic
//!
//! Contains the core DRC checking algorithms for layer-level clearance analysis.

use crate::draw::geometry::{ObjectRange, LayerJSON, SelectableObject};
use super::types::{DrcViolation, TriangleViolation};
use super::distance::{Triangle, triangle_distance};
use super::geometry::get_boundary_triangles_for_object;
use rayon::prelude::*;
use rstar::RTree;
use std::collections::HashMap;

/// Check if two objects should be DRC-checked against each other
pub fn should_check_pair(a: &ObjectRange, b: &ObjectRange) -> bool {
    // Different layers - skip (vias are on each layer separately)
    if a.layer_id != b.layer_id {
        return false;
    }

    // Same net - skip
    match (&a.net_name, &b.net_name) {
        (Some(na), Some(nb)) if na == nb => return false,
        _ => {}
    }

    true
}

/// Check clearances for objects on a single layer
pub fn check_layer_clearances(
    layer: &LayerJSON,
    objects: &[&SelectableObject],
    spatial_index: &RTree<SelectableObject>,
    clearance: f32,
) -> Vec<DrcViolation> {
    // Cache: object_id -> boundary triangles
    let boundary_cache: HashMap<u64, Vec<Triangle>> = objects
        .par_iter()
        .map(|obj| {
            (
                obj.range.id,
                get_boundary_triangles_for_object(&obj.range, layer),
            )
        })
        .collect();

    objects
        .par_iter()
        .flat_map(|obj_a| {
            let mut violations = Vec::new();

            // R-tree query with clearance expansion
            let search_bounds = rstar::AABB::from_corners(
                [
                    obj_a.range.bounds[0] - clearance,
                    obj_a.range.bounds[1] - clearance,
                ],
                [
                    obj_a.range.bounds[2] + clearance,
                    obj_a.range.bounds[3] + clearance,
                ],
            );

            for neighbor in spatial_index.locate_in_envelope_intersecting(&search_bounds) {
                let obj_b = &neighbor.range;

                // Only check each pair once (a.id < b.id)
                if obj_a.range.id >= obj_b.id {
                    continue;
                }

                // Apply filters
                if !should_check_pair(&obj_a.range, obj_b) {
                    continue;
                }

                // Get cached boundary triangles
                let tris_a = match boundary_cache.get(&obj_a.range.id) {
                    Some(t) => t,
                    None => continue,
                };
                let tris_b = match boundary_cache.get(&obj_b.id) {
                    Some(t) => t,
                    None => continue,
                };

                // Check clearance
                if let Some(v) =
                    check_triangle_clearance(&obj_a.range, obj_b, tris_a, tris_b, clearance)
                {
                    violations.push(v);
                }
            }

            violations
        })
        .collect()
}

/// Check clearance between two sets of boundary triangles
pub fn check_triangle_clearance(
    obj_a: &ObjectRange,
    obj_b: &ObjectRange,
    tris_a: &[Triangle],
    tris_b: &[Triangle],
    clearance: f32,
) -> Option<DrcViolation> {
    for tri_a in tris_a {
        for tri_b in tris_b {
            // AABB pre-filter: skip if triangle AABBs are far apart
            if tri_a.aabb_distance(tri_b) > clearance {
                continue;
            }

            // Precise triangle-to-triangle distance
            let (dist, point) = triangle_distance(tri_a, tri_b);
            
            // Early termination: violation found
            if dist < clearance {
                return Some(DrcViolation {
                    object_a_id: obj_a.id,
                    object_b_id: obj_b.id,
                    layer_id: obj_a.layer_id.clone(),
                    distance_mm: dist,
                    clearance_mm: clearance,
                    point,
                    net_a: obj_a.net_name.clone(),
                    net_b: obj_b.net_name.clone(),
                });
            }
        }
    }

    None // No violation
}

/// Check clearance and collect ALL violating triangle pairs (not just first)
pub fn check_triangle_clearance_all(
    obj_a: &ObjectRange,
    obj_b: &ObjectRange,
    tris_a: &[Triangle],
    tris_b: &[Triangle],
    clearance: f32,
) -> Vec<TriangleViolation> {
    let mut violations = Vec::new();

    for tri_a in tris_a {
        for tri_b in tris_b {
            // AABB pre-filter
            if tri_a.aabb_distance(tri_b) > clearance {
                continue;
            }

            // Precise triangle-to-triangle distance
            let (dist, _point) = triangle_distance(tri_a, tri_b);
            if dist < clearance {
                violations.push(TriangleViolation {
                    object_a_id: obj_a.id,
                    object_b_id: obj_b.id,
                    layer_id: obj_a.layer_id.clone(),
                    distance_mm: dist,
                    clearance_mm: clearance,
                    net_a: obj_a.net_name.clone(),
                    net_b: obj_b.net_name.clone(),
                    tri_a: [tri_a.v0, tri_a.v1, tri_a.v2],
                    tri_b: [tri_b.v0, tri_b.v1, tri_b.v2],
                });
            }
        }
    }

    violations
}

/// Check layer clearances and return all triangle violations
pub fn check_layer_clearances_all(
    layer: &LayerJSON,
    objects: &[&SelectableObject],
    spatial_index: &RTree<SelectableObject>,
    clearance: f32,
) -> Vec<TriangleViolation> {
    // Cache: object_id -> boundary triangles
    let boundary_cache: HashMap<u64, Vec<Triangle>> = objects
        .par_iter()
        .map(|obj| {
            (
                obj.range.id,
                get_boundary_triangles_for_object(&obj.range, layer),
            )
        })
        .collect();

    objects
        .par_iter()
        .flat_map(|obj_a| {
            let mut violations = Vec::new();

            // R-tree query with clearance expansion
            let search_bounds = rstar::AABB::from_corners(
                [
                    obj_a.range.bounds[0] - clearance,
                    obj_a.range.bounds[1] - clearance,
                ],
                [
                    obj_a.range.bounds[2] + clearance,
                    obj_a.range.bounds[3] + clearance,
                ],
            );

            for neighbor in spatial_index.locate_in_envelope_intersecting(&search_bounds) {
                let obj_b = &neighbor.range;

                // Only check each pair once
                if obj_a.range.id >= obj_b.id {
                    continue;
                }

                if !should_check_pair(&obj_a.range, obj_b) {
                    continue;
                }

                let tris_a = match boundary_cache.get(&obj_a.range.id) {
                    Some(t) => t,
                    None => continue,
                };
                let tris_b = match boundary_cache.get(&obj_b.id) {
                    Some(t) => t,
                    None => continue,
                };

                // Collect ALL violations
                violations.extend(check_triangle_clearance_all(&obj_a.range, obj_b, tris_a, tris_b, clearance));
            }

            violations
        })
        .collect()
}

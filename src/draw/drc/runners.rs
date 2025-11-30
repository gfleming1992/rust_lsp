//! DRC runner functions
//! 
//! Contains the main entry points for running DRC checks:
//! - Full DRC on all conductor layers
//! - Targeted DRC on specific objects

use crate::draw::geometry::{LayerJSON, SelectableObject};
use rayon::prelude::*;
use rstar::{RTree, AABB};
use std::collections::{HashMap, HashSet};

use super::types::{DrcViolation, DesignRules, is_copper_layer};
use super::{checks, geometry};

/// Run full DRC on all conductor layers
/// Returns list of violations found
pub fn run_full_drc(
    layers: &[LayerJSON],
    spatial_index: &RTree<SelectableObject>,
    rules: &DesignRules,
) -> Vec<DrcViolation> {
    let start = std::time::Instant::now();
    let clearance = rules.conductor_clearance_mm;

    // Collect all objects from spatial index
    let all_objects: Vec<&SelectableObject> = spatial_index.iter().collect();
    
    // Filter to copper layers only
    let copper_layer_ids: HashSet<String> = layers
        .iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.clone())
        .collect();

    eprintln!(
        "[DRC] Found {} copper layers out of {} total",
        copper_layer_ids.len(),
        layers.len()
    );

    // Group objects by layer for same-layer checking
    let objects_by_layer: HashMap<&str, Vec<&SelectableObject>> = all_objects
        .iter()
        .filter(|o| copper_layer_ids.contains(&o.range.layer_id))
        .fold(HashMap::new(), |mut map, obj| {
            map.entry(obj.range.layer_id.as_str())
                .or_default()
                .push(*obj);
            map
        });

    // Create layer lookup for geometry access
    let layer_lookup: HashMap<&str, &LayerJSON> = layers
        .iter()
        .map(|l| (l.layer_id.as_str(), l))
        .collect();

    // Parallel per-layer DRC
    let violations: Vec<DrcViolation> = objects_by_layer
        .par_iter()
        .flat_map(|(layer_id, layer_objects)| {
            if let Some(layer) = layer_lookup.get(layer_id) {
                checks::check_layer_clearances(layer, layer_objects, spatial_index, clearance)
            } else {
                vec![]
            }
        })
        .collect();

    eprintln!(
        "[DRC] Full check completed: {} objects checked, {} violations found in {:?}",
        all_objects.len(),
        violations.len(),
        start.elapsed()
    );

    violations
}

/// Run targeted DRC on specific objects (after edit)
/// Returns new violations for just those objects
pub fn run_targeted_drc(
    object_ids: &[u64],
    layers: &[LayerJSON],
    spatial_index: &RTree<SelectableObject>,
    rules: &DesignRules,
    existing_violations: &mut Vec<DrcViolation>,
) -> Vec<DrcViolation> {
    let start = std::time::Instant::now();
    let clearance = rules.conductor_clearance_mm;

    // Remove existing violations involving these objects
    let object_id_set: HashSet<u64> = object_ids.iter().copied().collect();
    existing_violations.retain(|v| {
        !object_id_set.contains(&v.object_a_id) && !object_id_set.contains(&v.object_b_id)
    });

    // Find the objects in the spatial index
    let all_objects: Vec<&SelectableObject> = spatial_index.iter().collect();
    let target_objects: Vec<&SelectableObject> = all_objects
        .iter()
        .filter(|o| object_id_set.contains(&o.range.id))
        .copied()
        .collect();

    if target_objects.is_empty() {
        return vec![];
    }

    // Create layer lookup
    let layer_lookup: HashMap<&str, &LayerJSON> = layers
        .iter()
        .map(|l| (l.layer_id.as_str(), l))
        .collect();

    // Copper layer check
    let copper_layer_ids: HashSet<String> = layers
        .iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.clone())
        .collect();

    // Check each target object against its neighbors
    let new_violations: Vec<DrcViolation> = target_objects
        .par_iter()
        .flat_map(|obj_a| {
            let mut violations = Vec::new();

            // Skip non-copper layers
            if !copper_layer_ids.contains(&obj_a.range.layer_id) {
                return violations;
            }

            let layer = match layer_lookup.get(obj_a.range.layer_id.as_str()) {
                Some(l) => l,
                None => return violations,
            };

            // Query R-tree for nearby objects
            let search_bounds = AABB::from_corners(
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

                // Skip if same object
                if obj_a.range.id == obj_b.id {
                    continue;
                }

                // Apply filters
                if !checks::should_check_pair(&obj_a.range, obj_b) {
                    continue;
                }

                // Get boundary triangles
                let tris_a = geometry::get_boundary_triangles_for_object(&obj_a.range, layer);
                let tris_b = geometry::get_boundary_triangles_for_object(obj_b, layer);

                // Check clearance
                if let Some(v) =
                    checks::check_triangle_clearance(&obj_a.range, obj_b, &tris_a, &tris_b, clearance)
                {
                    violations.push(v);
                }
            }

            violations
        })
        .collect();

    eprintln!(
        "[DRC] Targeted check for {} objects: {} new violations in {:?}",
        object_ids.len(),
        new_violations.len(),
        start.elapsed()
    );

    existing_violations.extend(new_violations.clone());
    new_violations
}

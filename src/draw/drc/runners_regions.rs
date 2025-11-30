//! Region-based DRC runner functions
//! 
//! Contains DRC runners that work with violation regions:
//! - Full DRC with region visualization
//! - Incremental DRC for modified regions

use crate::draw::geometry::{LayerJSON, SelectableObject};
use rayon::prelude::*;
use rstar::RTree;
use std::collections::{HashMap, HashSet};

use super::types::{
    DrcRegion, DesignRules, ModifiedRegionInfo,
    TriangleViolation, is_copper_layer,
};
use super::{checks, regions};

/// Run full DRC and return fused regions for visualization
pub fn run_full_drc_with_regions(
    layers: &[LayerJSON],
    spatial_index: &RTree<SelectableObject>,
    rules: &DesignRules,
    deleted_object_ids: &HashSet<u64>,
) -> Vec<DrcRegion> {
    let start = std::time::Instant::now();
    let clearance = rules.conductor_clearance_mm;

    // Filter out deleted objects from spatial index
    let all_objects: Vec<&SelectableObject> = spatial_index
        .iter()
        .filter(|o| !deleted_object_ids.contains(&o.range.id))
        .collect();
    
    eprintln!(
        "[DRC Regions] Checking {} objects ({} deleted/excluded)",
        all_objects.len(),
        deleted_object_ids.len()
    );
    
    let copper_layer_ids: HashSet<String> = layers
        .iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.clone())
        .collect();

    eprintln!(
        "[DRC Regions] Found {} copper layers out of {} total",
        copper_layer_ids.len(),
        layers.len()
    );

    let objects_by_layer: HashMap<&str, Vec<&SelectableObject>> = all_objects
        .iter()
        .filter(|o| copper_layer_ids.contains(&o.range.layer_id))
        .fold(HashMap::new(), |mut map, obj| {
            map.entry(obj.range.layer_id.as_str())
                .or_default()
                .push(*obj);
            map
        });

    let layer_lookup: HashMap<&str, &LayerJSON> = layers
        .iter()
        .map(|l| (l.layer_id.as_str(), l))
        .collect();

    // Collect all triangle violations
    let all_violations: Vec<TriangleViolation> = objects_by_layer
        .par_iter()
        .flat_map(|(layer_id, layer_objects)| {
            if let Some(layer) = layer_lookup.get(layer_id) {
                checks::check_layer_clearances_all(layer, layer_objects, spatial_index, clearance)
            } else {
                vec![]
            }
        })
        .collect();

    eprintln!(
        "[DRC Regions] Found {} triangle violations in {:?}",
        all_violations.len(),
        start.elapsed()
    );

    // Fuse into regions
    let fused_regions = regions::fuse_violations_into_regions(all_violations);

    eprintln!(
        "[DRC Regions] Fused into {} regions in {:?}",
        fused_regions.len(),
        start.elapsed()
    );

    fused_regions
}

/// Run incremental DRC only on regions that have been modified
/// Returns updated list of DRC regions, merging unchanged regions with new checks
pub fn run_incremental_drc_with_regions(
    layers: &[LayerJSON],
    spatial_index: &RTree<SelectableObject>,
    rules: &DesignRules,
    deleted_object_ids: &HashSet<u64>,
    modified_regions: &[ModifiedRegionInfo],
    existing_regions: &[DrcRegion],
) -> Vec<DrcRegion> {
    let start = std::time::Instant::now();
    let clearance = rules.conductor_clearance_mm;
    
    if modified_regions.is_empty() {
        eprintln!("[DRC Incremental] No modified regions, returning existing {} regions", existing_regions.len());
        return existing_regions.to_vec();
    }
    
    // Expand modified region bounds by clearance distance to catch nearby objects
    let expansion = clearance * 2.0;
    
    // Collect unique layer IDs from modified regions
    let affected_layers: HashSet<String> = modified_regions.iter()
        .map(|r| r.layer_id.clone())
        .collect();
    
    // Compute unified AABB per layer from all modified regions
    let mut layer_bounds: HashMap<String, [f32; 4]> = HashMap::new();
    for region in modified_regions {
        let entry = layer_bounds.entry(region.layer_id.clone()).or_insert([
            f32::MAX, f32::MAX, f32::MIN, f32::MIN
        ]);
        entry[0] = entry[0].min(region.bounds[0] - expansion);
        entry[1] = entry[1].min(region.bounds[1] - expansion);
        entry[2] = entry[2].max(region.bounds[2] + expansion);
        entry[3] = entry[3].max(region.bounds[3] + expansion);
    }
    
    eprintln!(
        "[DRC Incremental] Checking {} modified regions across {} layers",
        modified_regions.len(),
        affected_layers.len()
    );
    
    // Get all objects, excluding deleted ones
    let all_objects: Vec<&SelectableObject> = spatial_index
        .iter()
        .filter(|o| !deleted_object_ids.contains(&o.range.id))
        .collect();
    
    // Build copper layer set
    let copper_layer_ids: HashSet<String> = layers
        .iter()
        .filter(|l| is_copper_layer(&l.layer_function))
        .map(|l| l.layer_id.clone())
        .collect();
    
    // Filter to only objects in affected layers that overlap with expanded bounds
    let objects_to_check: Vec<&SelectableObject> = all_objects
        .iter()
        .filter(|o| {
            if !copper_layer_ids.contains(&o.range.layer_id) {
                return false;
            }
            if !affected_layers.contains(&o.range.layer_id) {
                return false;
            }
            // Check if object overlaps with the layer's modified bounds
            if let Some(layer_aabb) = layer_bounds.get(&o.range.layer_id) {
                let obj_bounds = o.range.bounds;
                // AABB overlap test
                obj_bounds[0] <= layer_aabb[2] && 
                obj_bounds[2] >= layer_aabb[0] &&
                obj_bounds[1] <= layer_aabb[3] && 
                obj_bounds[3] >= layer_aabb[1]
            } else {
                false
            }
        })
        .cloned()
        .collect();
    
    eprintln!(
        "[DRC Incremental] Found {} objects in affected regions (out of {} total)",
        objects_to_check.len(),
        all_objects.len()
    );
    
    // Group objects by layer for checking
    let objects_by_layer: HashMap<&str, Vec<&SelectableObject>> = objects_to_check
        .iter()
        .fold(HashMap::new(), |mut map, obj| {
            map.entry(obj.range.layer_id.as_str())
                .or_default()
                .push(*obj);
            map
        });
    
    let layer_lookup: HashMap<&str, &LayerJSON> = layers
        .iter()
        .map(|l| (l.layer_id.as_str(), l))
        .collect();
    
    // Run DRC on affected regions
    let new_violations: Vec<TriangleViolation> = objects_by_layer
        .par_iter()
        .flat_map(|(layer_id, layer_objects)| {
            if let Some(layer) = layer_lookup.get(layer_id) {
                checks::check_layer_clearances_all(layer, layer_objects, spatial_index, clearance)
            } else {
                vec![]
            }
        })
        .collect();
    
    eprintln!(
        "[DRC Incremental] Found {} new violations in affected regions",
        new_violations.len()
    );
    
    // Filter out old regions that overlap with modified areas (they'll be replaced)
    let retained_regions: Vec<DrcRegion> = existing_regions
        .iter()
        .filter(|region| {
            // Keep region if it doesn't overlap with any modified area
            if !affected_layers.contains(&region.layer_id) {
                return true;
            }
            if let Some(layer_aabb) = layer_bounds.get(&region.layer_id) {
                // Check if region overlaps with modified bounds
                let overlaps = region.bounds[0] <= layer_aabb[2] && 
                    region.bounds[2] >= layer_aabb[0] &&
                    region.bounds[1] <= layer_aabb[3] && 
                    region.bounds[3] >= layer_aabb[1];
                !overlaps  // Keep if NOT overlapping
            } else {
                true
            }
        })
        .cloned()
        .collect();
    
    eprintln!(
        "[DRC Incremental] Retained {} regions from previous DRC",
        retained_regions.len()
    );
    
    // Fuse new violations into regions
    let new_regions = regions::fuse_violations_into_regions(new_violations);
    let num_new = new_regions.len();
    let num_retained = retained_regions.len();
    
    // Merge retained and new regions, renumbering IDs
    let mut all_regions = retained_regions;
    all_regions.extend(new_regions);
    
    // Renumber region IDs
    for (i, region) in all_regions.iter_mut().enumerate() {
        region.id = i as u32;
    }
    
    eprintln!(
        "[DRC Incremental] Final: {} regions ({} retained + {} new) in {:?}",
        all_regions.len(),
        num_retained,
        num_new,
        start.elapsed()
    );
    
    all_regions
}

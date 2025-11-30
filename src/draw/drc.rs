//! Design Rule Check (DRC) for conductor clearance violations
//! 
//! Uses R-tree spatial indexing for efficient candidate pair filtering,
//! topology-based boundary triangle detection, and Rayon for parallel processing.

use crate::draw::geometry::{LayerJSON, ObjectRange, SelectableObject, GeometryLOD};
use rayon::prelude::*;
use rstar::{RTree, AABB};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Copper layer functions that require DRC checking
const COPPER_LAYER_FUNCTIONS: &[&str] = &[
    "SIGNAL",
    "PLANE",
    "MIXED",
    "CONDUCTOR",
    "CONDFILM",
    "CONDFOIL",
    "CONDUCTIVE_ADHESIVE",
];

/// A single triangle violation (internal, before fusion)
#[derive(Clone, Debug)]
struct TriangleViolation {
    object_a_id: u64,
    object_b_id: u64,
    layer_id: String,
    distance_mm: f32,
    clearance_mm: f32,
    net_a: Option<String>,
    net_b: Option<String>,
    // Triangle vertices from object A that caused the violation
    tri_a: [[f32; 2]; 3],
    // Triangle vertices from object B that caused the violation
    tri_b: [[f32; 2]; 3],
}

/// DRC violation with location details (point-based, for backward compatibility)
#[derive(Clone, Debug, Serialize)]
pub struct DrcViolation {
    pub object_a_id: u64,
    pub object_b_id: u64,
    pub layer_id: String,
    pub distance_mm: f32,
    pub clearance_mm: f32,
    pub point: [f32; 2],  // Closest approach point for visualization
    pub net_a: Option<String>,
    pub net_b: Option<String>,
}

/// A fused DRC region representing multiple adjacent triangle violations
#[derive(Clone, Debug, Serialize)]
pub struct DrcRegion {
    /// Unique region ID
    pub id: u32,
    /// Layer containing this violation
    pub layer_id: String,
    /// Minimum distance found in this region
    pub min_distance_mm: f32,
    /// Required clearance
    pub clearance_mm: f32,
    /// Net name from object A (first object involved)
    pub net_a: Option<String>,
    /// Net name from object B (second object involved)
    pub net_b: Option<String>,
    /// Bounding box [min_x, min_y, max_x, max_y] for fit-to-region
    pub bounds: [f32; 4],
    /// Center point of the violation region
    pub center: [f32; 2],
    /// All object IDs involved in this region (for highlighting)
    pub object_ids: Vec<u64>,
    /// Flattened triangle vertices for rendering overlay [x0,y0,x1,y1,x2,y2, ...]
    /// Contains triangles from both objects that caused violations
    pub triangle_vertices: Vec<f32>,
    /// Number of triangles in the region
    pub triangle_count: usize,
}

/// Design rules parsed from IPC-2581 or defaults
#[derive(Clone, Debug)]
pub struct DesignRules {
    pub conductor_clearance_mm: f32,
}

impl Default for DesignRules {
    fn default() -> Self {
        Self {
            conductor_clearance_mm: 0.15, // 6 mil default
        }
    }
}

/// Triangle with precomputed AABB for fast rejection
#[derive(Clone, Debug)]
struct Triangle {
    v0: [f32; 2],
    v1: [f32; 2],
    v2: [f32; 2],
    aabb_min: [f32; 2],
    aabb_max: [f32; 2],
}

impl Triangle {
    fn from_vertices(v0: [f32; 2], v1: [f32; 2], v2: [f32; 2]) -> Self {
        Self {
            v0,
            v1,
            v2,
            aabb_min: [
                v0[0].min(v1[0]).min(v2[0]),
                v0[1].min(v1[1]).min(v2[1]),
            ],
            aabb_max: [
                v0[0].max(v1[0]).max(v2[0]),
                v0[1].max(v1[1]).max(v2[1]),
            ],
        }
    }

    /// Fast AABB-to-AABB distance (lower bound)
    fn aabb_distance(&self, other: &Triangle) -> f32 {
        let dx = (self.aabb_min[0].max(other.aabb_min[0])
            - self.aabb_max[0].min(other.aabb_max[0]))
        .max(0.0);
        let dy = (self.aabb_min[1].max(other.aabb_min[1])
            - self.aabb_max[1].min(other.aabb_max[1]))
        .max(0.0);
        (dx * dx + dy * dy).sqrt()
    }
}

/// Check if a layer contains copper and needs DRC
pub fn is_copper_layer(layer_function: &str) -> bool {
    COPPER_LAYER_FUNCTIONS
        .iter()
        .any(|&f| f.eq_ignore_ascii_case(layer_function))
}

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
                check_layer_clearances(layer, layer_objects, spatial_index, clearance)
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

                // Skip if same object or already checked (handled by full DRC)
                if obj_a.range.id == obj_b.id {
                    continue;
                }

                // Apply filters
                if !should_check_pair(&obj_a.range, obj_b) {
                    continue;
                }

                // Get boundary triangles
                let tris_a = get_boundary_triangles_for_object(&obj_a.range, layer);
                let tris_b = get_boundary_triangles_for_object(obj_b, layer);

                // Check clearance
                if let Some(v) =
                    check_triangle_clearance(&obj_a.range, obj_b, &tris_a, &tris_b, clearance)
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

/// Check if two objects should be DRC-checked against each other
fn should_check_pair(a: &ObjectRange, b: &ObjectRange) -> bool {
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
fn check_layer_clearances(
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
fn check_triangle_clearance(
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
fn check_triangle_clearance_all(
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
fn check_layer_clearances_all(
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

/// Fuse triangle violations into regions based on spatial adjacency
fn fuse_violations_into_regions(violations: Vec<TriangleViolation>) -> Vec<DrcRegion> {
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
                check_layer_clearances_all(layer, layer_objects, spatial_index, clearance)
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
    let regions = fuse_violations_into_regions(all_violations);

    eprintln!(
        "[DRC Regions] Fused into {} regions in {:?}",
        regions.len(),
        start.elapsed()
    );

    regions
}

/// Extract boundary triangles from object's LOD0 geometry using edge adjacency
fn get_boundary_triangles_for_object(obj: &ObjectRange, layer: &LayerJSON) -> Vec<Triangle> {
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

/// Triangle-to-triangle minimum distance
fn triangle_distance(a: &Triangle, b: &Triangle) -> (f32, [f32; 2]) {
    let mut min_dist = f32::MAX;
    let mut closest = [0.0f32; 2];

    // Edge-edge distances (9 combinations)
    for (a1, a2) in [(a.v0, a.v1), (a.v1, a.v2), (a.v2, a.v0)] {
        for (b1, b2) in [(b.v0, b.v1), (b.v1, b.v2), (b.v2, b.v0)] {
            let (d, p) = segment_distance(a1, a2, b1, b2);
            if d < min_dist {
                min_dist = d;
                closest = p;
            }
        }
    }

    (min_dist, closest)
}

/// Segment-to-segment minimum distance
fn segment_distance(
    a1: [f32; 2],
    a2: [f32; 2],
    b1: [f32; 2],
    b2: [f32; 2],
) -> (f32, [f32; 2]) {
    let mut min_d = f32::MAX;
    let mut closest = [0.0f32; 2];

    // a1 to segment b
    let (d, p) = point_segment_distance(a1, b1, b2);
    if d < min_d {
        min_d = d;
        closest = midpoint(a1, p);
    }

    // a2 to segment b
    let (d, p) = point_segment_distance(a2, b1, b2);
    if d < min_d {
        min_d = d;
        closest = midpoint(a2, p);
    }

    // b1 to segment a
    let (d, p) = point_segment_distance(b1, a1, a2);
    if d < min_d {
        min_d = d;
        closest = midpoint(b1, p);
    }

    // b2 to segment a
    let (d, p) = point_segment_distance(b2, a1, a2);
    if d < min_d {
        min_d = d;
        closest = midpoint(b2, p);
    }

    (min_d, closest)
}

/// Point-to-segment minimum distance
fn point_segment_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> (f32, [f32; 2]) {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let ap = [p[0] - a[0], p[1] - a[1]];
    let ab_len2 = ab[0] * ab[0] + ab[1] * ab[1];

    if ab_len2 < 1e-10 {
        // Degenerate segment
        let d = ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
        return (d, a);
    }

    let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / ab_len2).clamp(0.0, 1.0);
    let closest = [a[0] + t * ab[0], a[1] + t * ab[1]];
    let d = ((p[0] - closest[0]).powi(2) + (p[1] - closest[1]).powi(2)).sqrt();

    (d, closest)
}

/// Midpoint of two points
fn midpoint(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]
}

/// Modified region information for incremental DRC
#[derive(Clone, Debug)]
pub struct ModifiedRegionInfo {
    pub bounds: [f32; 4],  // [min_x, min_y, max_x, max_y]
    pub layer_id: String,
    pub object_id: u64,
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
                check_layer_clearances_all(layer, layer_objects, spatial_index, clearance)
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
    let new_regions = fuse_violations_into_regions(new_violations);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_copper_layer() {
        assert!(is_copper_layer("SIGNAL"));
        assert!(is_copper_layer("signal"));
        assert!(is_copper_layer("PLANE"));
        assert!(is_copper_layer("MIXED"));
        assert!(!is_copper_layer("DOCUMENT"));
        assert!(!is_copper_layer("LEGEND"));
        assert!(!is_copper_layer("SOLDERMASK"));
    }

    #[test]
    fn test_triangle_aabb_distance() {
        let t1 = Triangle::from_vertices([0.0, 0.0], [1.0, 0.0], [0.5, 1.0]);
        let t2 = Triangle::from_vertices([2.0, 0.0], [3.0, 0.0], [2.5, 1.0]);

        // Triangles are separated by 1 unit in X
        let dist = t1.aabb_distance(&t2);
        assert!((dist - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_point_segment_distance() {
        let (d, _) = point_segment_distance([0.0, 1.0], [0.0, 0.0], [2.0, 0.0]);
        assert!((d - 1.0).abs() < 0.01);
    }
}

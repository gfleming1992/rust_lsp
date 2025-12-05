//! Spatial indexing types for efficient object selection
//! 
//! This module provides R-tree based spatial indexing for selectable objects,
//! enabling fast point and box queries for object selection.

use serde::{Serialize, Deserialize};
use rstar::{RTreeObject, AABB};

/// Metadata for a selectable object in the spatial index
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObjectRange {
    pub id: u64,
    pub layer_id: String,
    pub obj_type: u8, // 0=Polyline, 1=Polygon, 2=Via, 3=Pad
    pub vertex_ranges: Vec<(u32, u32)>, // (start, count) for each LOD
    pub instance_index: Option<u32>,    // For instanced types
    pub shape_index: Option<u32>,       // For instanced types: which shape/LOD entry group
    pub bounds: [f32; 4], // min_x, min_y, max_x, max_y
    pub net_name: Option<String>,       // Net name for highlighting
    pub component_ref: Option<String>,  // Component reference (e.g., "CMP:C1") for component highlighting
    pub pin_ref: Option<String>,        // Pin reference (e.g., "PIN:1") for pad identification
    
    // Precomputed polar coordinates for component rotation (calculated relative to component center)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_center: Option<[f32; 2]>,  // Component bounding box center [cx, cy]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polar_radius: Option<f32>,           // Distance from component center to object center
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polar_angle: Option<f32>,            // Angle in radians from component center to object center
}

/// Object wrapper for R-tree spatial indexing
#[derive(Clone, Debug)]
pub struct SelectableObject {
    pub range: ObjectRange,
    pub bounds: AABB<[f32; 2]>,
}

impl SelectableObject {
    pub fn new(range: ObjectRange) -> Self {
        let bounds = AABB::from_corners(
            [range.bounds[0], range.bounds[1]],
            [range.bounds[2], range.bounds[3]],
        );
        Self { range, bounds }
    }
}

impl RTreeObject for SelectableObject {
    type Envelope = AABB<[f32; 2]>;
    fn envelope(&self) -> Self::Envelope {
        self.bounds
    }
}

impl rstar::PointDistance for SelectableObject {
    fn distance_2(&self, point: &[f32; 2]) -> f32 {
        self.bounds.distance_2(point)
    }
}

use std::collections::HashMap;

/// Calculate component polar coordinates for all objects that belong to components.
/// This enables efficient rotation around component center at runtime.
/// 
/// For each component, we:
/// 1. Find all objects belonging to that component
/// 2. Calculate the component's bounding box center
/// 3. For each object, calculate its polar coordinates (radius, angle) relative to that center
pub fn calculate_component_polar_coords(object_ranges: &mut [ObjectRange]) {
    // Group objects by component_ref
    let mut component_objects: HashMap<String, Vec<usize>> = HashMap::new();
    
    for (idx, range) in object_ranges.iter().enumerate() {
        if let Some(ref comp_ref) = range.component_ref {
            component_objects.entry(comp_ref.clone()).or_default().push(idx);
        }
    }
    
    let mut total_with_polar = 0;
    
    // For each component, calculate center and polar coords
    for (comp_ref, indices) in &component_objects {
        if indices.is_empty() {
            continue;
        }
        
        // Calculate component bounding box
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        
        for &idx in indices {
            let bounds = &object_ranges[idx].bounds;
            min_x = min_x.min(bounds[0]);
            min_y = min_y.min(bounds[1]);
            max_x = max_x.max(bounds[2]);
            max_y = max_y.max(bounds[3]);
        }
        
        let center_x = (min_x + max_x) / 2.0;
        let center_y = (min_y + max_y) / 2.0;
        let component_center = [center_x, center_y];
        
        // Calculate polar coords for each object in this component
        for &idx in indices {
            let range = &mut object_ranges[idx];
            
            // Object center
            let obj_center_x = (range.bounds[0] + range.bounds[2]) / 2.0;
            let obj_center_y = (range.bounds[1] + range.bounds[3]) / 2.0;
            
            // Relative position
            let rel_x = obj_center_x - center_x;
            let rel_y = obj_center_y - center_y;
            
            // Polar coordinates
            let radius = (rel_x * rel_x + rel_y * rel_y).sqrt();
            let angle = rel_y.atan2(rel_x); // atan2(y, x) gives angle in radians
            
            range.component_center = Some(component_center);
            range.polar_radius = Some(radius);
            range.polar_angle = Some(angle);
            total_with_polar += 1;
        }
        
        if indices.len() > 10 {
            eprintln!("[Polar] Component {} has {} objects, center: ({:.3}, {:.3})", 
                comp_ref, indices.len(), center_x, center_y);
        }
    }
    
    eprintln!("[Polar] Calculated polar coordinates for {} objects in {} components",
        total_with_polar, component_objects.len());
}

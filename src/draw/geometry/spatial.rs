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

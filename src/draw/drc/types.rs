//! DRC data types and structures
//!
//! Contains violation, region, and rule definitions for DRC checking.

use serde::Serialize;

/// Copper layer functions that require DRC checking
pub const COPPER_LAYER_FUNCTIONS: &[&str] = &[
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
pub struct TriangleViolation {
    pub object_a_id: u64,
    pub object_b_id: u64,
    pub layer_id: String,
    pub distance_mm: f32,
    pub clearance_mm: f32,
    pub net_a: Option<String>,
    pub net_b: Option<String>,
    /// Triangle vertices from object A that caused the violation
    pub tri_a: [[f32; 2]; 3],
    /// Triangle vertices from object B that caused the violation
    pub tri_b: [[f32; 2]; 3],
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

/// Modified region information for incremental DRC
#[derive(Clone, Debug)]
pub struct ModifiedRegionInfo {
    pub bounds: [f32; 4],  // [min_x, min_y, max_x, max_y]
    pub layer_id: String,
    pub object_id: u64,
}

/// Check if a layer contains copper and needs DRC
pub fn is_copper_layer(layer_function: &str) -> bool {
    COPPER_LAYER_FUNCTIONS
        .iter()
        .any(|&f| f.eq_ignore_ascii_case(layer_function))
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
}

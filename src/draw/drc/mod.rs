//! Design Rule Check (DRC) for conductor clearance violations
//! 
//! Uses R-tree spatial indexing for efficient candidate pair filtering,
//! topology-based boundary triangle detection, and Rayon for parallel processing.
//!
//! # Submodules
//! - `types` - DRC data structures (violations, regions, rules)
//! - `distance` - Distance calculation algorithms
//! - `geometry` - Triangle extraction from layer geometry
//! - `regions` - Region fusion logic
//! - `checks` - Layer clearance checking
//! - `runners` - Basic DRC entry points (full, targeted)
//! - `runners_regions` - Region-based DRC entry points

mod types;
mod distance;
mod geometry;
mod regions;
mod checks;
mod runners;
mod runners_regions;

// Re-export public types
pub use types::{
    DrcViolation, DrcRegion, DesignRules, ModifiedRegionInfo,
    TriangleViolation, is_copper_layer,
};

// Re-export runner functions
pub use runners::{
    run_full_drc,
    run_targeted_drc,
};

pub use runners_regions::{
    run_full_drc_with_regions,
    run_incremental_drc_with_regions,
};

//! Tessellation module for PCB geometry
//!
//! This module provides tessellation functions to convert 2D PCB geometry
//! (polylines, polygons, pads, vias) into triangle meshes for GPU rendering.
//!
//! # Submodules
//! - `simplify` - Douglas-Peucker simplification and LOD generation
//! - `polyline` - Polyline stroking with line caps and joins
//! - `polygon` - Polygon triangulation using earcut
//! - `shapes` - Standard shape tessellation (circles, rectangles, etc.)

mod simplify;
mod polyline;
mod polygon;
mod shapes;

// Re-export all public functions for backward compatibility
pub use simplify::{
    douglas_peucker,
    generate_polyline_lods,
};

pub use polyline::{
    MIN_VISIBLE_WIDTH_LOD,
    tessellate_polyline,
    batch_polylines_with_styles,
};

pub use polygon::{
    tessellate_polygon,
    tessellate_padstack_holes,
    tessellate_custom_polygon,
};

pub use shapes::{
    tessellate_circle,
    tessellate_annular_ring,
    tessellate_rectangle,
    tessellate_rectangular_ring,
    tessellate_oval,
    tessellate_roundrect,
    tessellate_primitive,
};

//! Geometry module for IPC-2581 PCB data
//! 
//! This module provides all geometric types and utilities for representing
//! and serializing PCB geometry data including polylines, polygons, pads, and vias.
//!
//! # Submodules
//! - `types` - Core geometric primitives (Point, Polyline, Polygon, etc.)
//! - `spatial` - Spatial indexing for efficient object selection
//! - `lod` - Level of Detail geometry for GPU rendering
//! - `binary` - Binary serialization for zero-copy transfer

mod types;
mod spatial;
mod lod;
mod binary;

// Re-export all public types for backward compatibility
pub use types::{
    Point,
    LineEnd,
    LineDescriptor,
    Polyline,
    Polygon,
    PadStackHole,
    StandardPrimitive,
    PadInstance,
    PadStackDef,
    ViaInstance,
    LayerGeometries,
};

pub use spatial::{
    ObjectRange,
    SelectableObject,
    calculate_component_polar_coords,
};

pub use lod::{
    serialize_f32_vec_as_base64,
    serialize_f32_vec_base64,
    serialize_u32_vec_as_base64,
    pack_rotation_visibility,
    GeometryLOD,
    CullingStats,
    ShaderGeometry,
    LayerJSON,
};

pub use binary::{
    LayerBinary,
    serialize_geometry_binary,
};

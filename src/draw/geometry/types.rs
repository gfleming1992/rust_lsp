//! Core geometry types for IPC-2581 PCB data
//! 
//! This module contains the fundamental geometric primitives used throughout
//! the application: points, polylines, polygons, pads, and vias.

use serde::Serialize;

/// A 2D point
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Line end style
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum LineEnd {
    #[default]
    Round,
    Square,
    Butt,
}

/// Line descriptor from DictionaryLineDesc
#[derive(Debug, Clone)]
pub struct LineDescriptor {
    pub line_width: f32,
    pub line_end: LineEnd,
}

/// Represents a single polyline
#[derive(Debug, Clone)]
pub struct Polyline {
    pub points: Vec<Point>,
    pub width: f32,
    pub color: [f32; 4],
    pub line_end: LineEnd,
    pub net_name: Option<String>,
    pub component_ref: Option<String>,
}

/// Represents a filled polygon (with optional holes)
#[derive(Debug, Clone)]
pub struct Polygon {
    pub outer_ring: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
    pub fill_color: [f32; 4],  // Supports alpha for transparency
    pub net_name: Option<String>,
    pub component_ref: Option<String>,
}

/// Represents a pad stack hole with optional annular ring
#[derive(Debug, Clone)]
pub struct PadStackHole {
    pub x: f32,
    pub y: f32,
    pub hole_diameter: f32,
    pub ring_width: f32,  // 0 means no ring, just hole
}

/// Standard primitive shape definition
#[derive(Debug, Clone, Serialize)]
pub enum StandardPrimitive {
    Circle { diameter: f32 },
    Rectangle { width: f32, height: f32 },
    Oval { width: f32, height: f32 },
    RoundRect { width: f32, height: f32, corner_radius: f32 },
    CustomPolygon { points: Vec<Point> },
}

/// Pad instance with shape reference, position, and rotation
#[derive(Debug, Clone, Serialize)]
pub struct PadInstance {
    pub shape_id: String,
    pub x: f32,
    pub y: f32,
    pub rotation: f32,  // degrees
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_ref: Option<String>,  // Component reference from PinRef
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_ref: Option<String>,        // Pin reference from PinRef (e.g., "PIN:1")
}

/// Padstack definition (for vias and component pads)
#[derive(Debug, Clone)]
pub struct PadStackDef {
    pub hole_diameter: f32,
    pub outer_diameter: f32,  // From pad definition circle (deprecated for non-circles)
    pub shape: StandardPrimitive,  // Actual pad shape
}

/// Via instance (hole through layers - can be circular, square, etc.)
#[derive(Debug, Clone, Serialize)]
pub struct ViaInstance {
    pub x: f32,
    pub y: f32,
    pub diameter: f32,  // For circles, or max dimension for other shapes
    pub hole_diameter: f32,
    pub shape: StandardPrimitive,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_ref: Option<String>,  // Component reference for PTH pads
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_ref: Option<String>,        // Pin reference for PTH component pads (e.g., "PIN:1")
}

/// Represents all geometries organized by layer
#[derive(Debug)]
pub struct LayerGeometries {
    pub layer_ref: String,
    pub polylines: Vec<Polyline>,
    pub polygons: Vec<Polygon>,
    pub padstack_holes: Vec<PadStackHole>,
    pub pads: Vec<PadInstance>,
    pub vias: Vec<ViaInstance>,
}

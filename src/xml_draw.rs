/// XML Draw module - Extracts polylines from IPC-2581 XML and generates LOD geometries
/// 
/// This module handles:
/// 1. Extracting LayerFeatures → Polylines from parsed XML
/// 2. Generating 5-level LODs using Douglas-Peucker simplification
/// 3. Tessellating polylines into vertex/index buffers matching BatchedPolylines.js
/// 4. Serializing to LayerJSON format for WebGPU rendering
///
/// The LOD system:
/// - LOD0: Full detail (original polyline points)
/// - LOD1-4: Progressively simplified using Douglas-Peucker
/// - Tolerance increases ~4x per level (configurable)
/// - Vertex/index data base64-encoded as Float32Array/Uint32Array

use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use std::env;
use base64::{Engine as _, engine::general_purpose};

/// Serialize Vec<f32> as base64-encoded string for compact JSON transmission
fn serialize_f32_vec_as_base64<S>(data: &Option<Vec<f32>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match data {
        Some(vec) => {
            let bytes: &[u8] = unsafe {
                std::slice::from_raw_parts(
                    vec.as_ptr() as *const u8,
                    vec.len() * std::mem::size_of::<f32>(),
                )
            };
            let encoded = general_purpose::STANDARD.encode(bytes);
            serializer.serialize_some(&encoded)
        }
        None => serializer.serialize_none(),
    }
}

/// A 2D point
#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Line end style
#[derive(Debug, Clone, Copy, PartialEq)]
#[derive(Default)]
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
}

/// Represents a filled polygon (with optional holes)
#[derive(Debug, Clone)]
pub struct Polygon {
    pub outer_ring: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
    pub fill_color: [f32; 4],  // Supports alpha for transparency
}

/// Represents a pad stack hole with optional annular ring
#[derive(Debug, Clone)]
pub struct PadStackHole {
    pub x: f32,
    pub y: f32,
    pub hole_diameter: f32,
    pub ring_width: f32,  // 0 means no ring, just hole
}

/// Represents all geometries organized by layer
#[derive(Debug)]
pub struct LayerGeometries {
    pub layer_ref: String,
    pub polylines: Vec<Polyline>,
    pub polygons: Vec<Polygon>,
    pub padstack_holes: Vec<PadStackHole>,
}

/// Serializable geometry LOD for JSON
#[derive(Serialize)]
pub struct GeometryLOD {
    /// Raw Float32 vertex data as number array (x, y, x, y, ...)
    /// JavaScript will receive this directly as Float32Array without decoding
    #[serde(rename = "vertexData")]
    pub vertex_data: Vec<f32>,
    
    /// Number of vertices (not bytes)
    #[serde(rename = "vertexCount")]
    pub vertex_count: usize,
    
    /// Optional Uint32 indices as number array
    #[serde(rename = "indexData")]
    pub index_data: Option<Vec<u32>>,
    
    /// Optional number of indices
    #[serde(rename = "indexCount")]
    pub index_count: Option<usize>,
    
    /// Optional per-vertex alpha values (1 float per vertex), serialized as base64 string
    #[serde(rename = "alphaData", skip_serializing_if = "Option::is_none", serialize_with = "serialize_f32_vec_as_base64")]
    pub alpha_data: Option<Vec<f32>>,
}

/// Culling statistics for optimization reporting
#[derive(Debug, Default)]
pub struct CullingStats {
    pub lod_culled: [usize; 5],
    pub total_polylines: usize,
}

/// Shader geometry organized by type
#[derive(Serialize, Default)]
pub struct ShaderGeometry {
    /// For batch.wgsl - polylines without alpha (opaque, alpha=1.0 implicit)
    pub batch: Option<Vec<GeometryLOD>>,
    
    /// For batch_colored.wgsl - polygons with per-vertex alpha transparency
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_colored: Option<Vec<GeometryLOD>>,
}

/// Complete layer JSON structure matching main.ts
#[derive(Serialize)]
pub struct LayerJSON {
    #[serde(rename = "layerId")]
    pub layer_id: String,
    
    #[serde(rename = "layerName")]
    pub layer_name: String,
    
    #[serde(rename = "defaultColor")]
    pub default_color: [f32; 4],
    
    pub geometry: ShaderGeometry,
}

/// Binary layer data structure for zero-copy transfer
pub struct LayerBinary {
    pub layer_id: String,
    pub layer_name: String,
    pub default_color: [f32; 4],
    pub geometry_data: Vec<u8>,
}

impl LayerBinary {
    /// Create binary layer data from LayerJSON
    pub fn from_layer_json(layer: &LayerJSON) -> Self {
        let geometry_data = serialize_geometry_binary(&layer.geometry);
        
        LayerBinary {
            layer_id: layer.layer_id.clone(),
            layer_name: layer.layer_name.clone(),
            default_color: layer.default_color,
            geometry_data,
        }
    }
    
    /// Write to binary file format
    /// Format: [header][metadata][geometry_data]
    /// Header: "IPC2581B" (8 bytes magic)
    /// Metadata: layer_id_len(u32) + layer_id + padding + layer_name_len(u32) + layer_name + padding + color(4 x f32)
    /// Padding ensures 4-byte alignment for Float32Array/Uint32Array views
    /// Geometry: custom binary format
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buffer = Vec::new();
        
        // Magic header (8 bytes - already aligned)
        buffer.extend_from_slice(b"IPC2581B");
        
        // Layer ID (length-prefixed string with padding to 4-byte boundary)
        let id_bytes = self.layer_id.as_bytes();
        buffer.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
        buffer.extend_from_slice(id_bytes);
        // Add padding to align to 4-byte boundary
        let id_padding = (4 - (id_bytes.len() % 4)) % 4;
        buffer.resize(buffer.len() + id_padding, 0);
        
        // Layer name (length-prefixed string with padding to 4-byte boundary)
        let name_bytes = self.layer_name.as_bytes();
        buffer.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
        buffer.extend_from_slice(name_bytes);
        // Add padding to align to 4-byte boundary
        let name_padding = (4 - (name_bytes.len() % 4)) % 4;
        buffer.resize(buffer.len() + name_padding, 0);
        
        // Default color (4 x f32 - already 4-byte aligned)
        for &c in &self.default_color {
            buffer.extend_from_slice(&c.to_le_bytes());
        }
        
        // Geometry data (already properly aligned internally)
        buffer.extend_from_slice(&self.geometry_data);
        
        buffer
    }
}

/// Serialize geometry to custom binary format
/// Format: [num_lods: u32][lod0][lod1]...[lodN]
/// Each LOD: [vertex_count: u32][index_count: u32][vertex_data][index_data]
/// vertex_data: raw f32 array (x,y,x,y,...)
/// index_data: raw u32 array
fn serialize_geometry_binary(geometry: &ShaderGeometry) -> Vec<u8> {
    let mut buffer = Vec::new();
    
    // Serialize batch geometry (polylines without alpha)
    let batch_lods = geometry.batch.as_ref();
    if let Some(lods) = batch_lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Raw vertex data (Float32)
            for &f in &lod.vertex_data {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
            // Raw index data (Uint32)
            if let Some(indices) = &lod.index_data {
                for &idx in indices {
                    buffer.extend_from_slice(&idx.to_le_bytes());
                }
            }
        }
    } else {
        // No batch geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    // Serialize batch_colored geometry (polygons with alpha)
    let batch_colored_lods = geometry.batch_colored.as_ref();
    if let Some(lods) = batch_colored_lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Has alpha flag
            let has_alpha = lod.alpha_data.is_some();
            buffer.push(if has_alpha { 1 } else { 0 });
            // Padding to maintain 4-byte alignment
            buffer.extend_from_slice(&[0u8, 0u8, 0u8]);
            
            // Raw vertex data (Float32)
            for &f in &lod.vertex_data {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
            // Raw index data (Uint32)
            if let Some(indices) = &lod.index_data {
                for &idx in indices {
                    buffer.extend_from_slice(&idx.to_le_bytes());
                }
            }
            // Alpha data (Float32) if present
            if let Some(alpha_values) = &lod.alpha_data {
                for &alpha in alpha_values {
                    buffer.extend_from_slice(&alpha.to_le_bytes());
                }
            }
        }
    } else {
        // No batch_colored geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    buffer
}

/// Extract polylines from a LayerFeatures XML node
#[allow(dead_code)]
fn extract_polylines_from_layer(
    layer_node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Vec<Polyline>, anyhow::Error> {
    let mut polylines = Vec::new();
    
    // Find all Polyline children
    for child in &layer_node.children {
        if child.name == "Polyline" {
            if let Ok(polyline) = parse_polyline_node(child, line_descriptors) {
                polylines.push(polyline);
            }
        }
    }
    
    Ok(polylines)
}

/// Parse a single Polyline XML node
fn parse_polyline_node(
    node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Polyline, anyhow::Error> {
    let mut points = Vec::new();
    let mut width: f32 = node
        .attributes
        .get("width")
        .and_then(|w| w.parse().ok())
        .unwrap_or(0.1);
    let mut line_end = LineEnd::Round;

    // Extract color from attributes or use default
    let color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 1.0]);

    // Look for LineDescRef to get actual width and line end
    let mut line_desc_ref: Option<String> = None;
    
    // Extract points from various child node types
    for child in &node.children {
        match child.name.as_str() {
            // Standard point format
            "Pt" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            // IPC-2581 polyline format: PolyBegin + PolyStepSegment
            "PolyBegin" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            "PolyStepSegment" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            "LineDescRef" => {
                if let Some(id) = child.attributes.get("id") {
                    line_desc_ref = Some(id.clone());
                }
            }
            _ => {}
        }
    }

    // Apply line descriptor if found
    if let Some(ref_id) = line_desc_ref {
        if let Some(descriptor) = line_descriptors.get(&ref_id) {
            width = descriptor.line_width;
            line_end = descriptor.line_end;
        }
    }

    Ok(Polyline {
        points,
        width,
        color,
        line_end,
    })
}

/// Parse a Line XML node by converting it into a two-point polyline
fn parse_line_node(
    node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Polyline, anyhow::Error> {
    let start_x = node
        .attributes
        .get("startX")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing startX attribute"))?;
    let start_y = node
        .attributes
        .get("startY")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing startY attribute"))?;
    let end_x = node
        .attributes
        .get("endX")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing endX attribute"))?;
    let end_y = node
        .attributes
        .get("endY")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing endY attribute"))?;

    let mut width: f32 = node
        .attributes
        .get("width")
        .and_then(|w| w.parse().ok())
        .unwrap_or(0.1);
    let mut line_end = LineEnd::Round;

    let color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 1.0]);

    let mut line_desc_ref: Option<String> = None;

    for child in &node.children {
        match child.name.as_str() {
            "LineDescRef" => {
                if let Some(id) = child.attributes.get("id") {
                    line_desc_ref = Some(id.clone());
                }
            }
            "LineDesc" => {
                if let Some(w) = child.attributes.get("lineWidth") {
                    if let Ok(parsed) = w.parse::<f32>() {
                        width = parsed;
                    }
                }
                if let Some(end) = child.attributes.get("lineEnd") {
                    line_end = parse_line_end(end);
                }
            }
            _ => {}
        }
    }

    if let Some(ref_id) = line_desc_ref {
        if let Some(descriptor) = line_descriptors.get(&ref_id) {
            width = descriptor.line_width;
            line_end = descriptor.line_end;
        }
    }

    Ok(Polyline {
        points: vec![
            Point { x: start_x, y: start_y },
            Point { x: end_x, y: end_y },
        ],
        width,
        color,
        line_end,
    })
}

/// Parse line end from string
fn parse_line_end(line_end_str: &str) -> LineEnd {
    match line_end_str.to_uppercase().as_str() {
        "ROUND" => LineEnd::Round,
        "SQUARE" => LineEnd::Square,
        "BUTT" => LineEnd::Butt,
        _ => LineEnd::Round, // Default to round
    }
}

/// Parse a Polygon node (filled shape with optional holes)
/// Expects <Polygon> with PolyBegin/PolyStepSegment children
fn parse_polygon_node(node: &XmlNode) -> Result<Polygon, anyhow::Error> {
    let mut outer_ring: Vec<Point> = Vec::new();
    let mut current_ring: Vec<Point> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    let mut is_first_contour = true;
    
    // Extract fill color from attributes or use default with alpha
    let fill_color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 0.5]);
    
    // Parse polygon contours (outer ring + holes)
    for child in &node.children {
        match child.name.as_str() {
            "PolyBegin" => {
                // Save previous contour if exists
                if !current_ring.is_empty() {
                    if is_first_contour {
                        outer_ring = current_ring.clone();
                        is_first_contour = false;
                    } else {
                        holes.push(current_ring.clone());
                    }
                    current_ring.clear();
                }
                
                // Start new contour
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        current_ring.push(Point { x, y });
                    }
                }
            }
            "PolyStepSegment" | "PolyStepCurve" => {
                // Add point to current contour
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        current_ring.push(Point { x, y });
                    }
                }
            }
            _ => {}
        }
    }
    
    // Save last contour
    if !current_ring.is_empty() {
        if is_first_contour {
            outer_ring = current_ring;
        } else {
            holes.push(current_ring);
        }
    }
    
    if outer_ring.len() < 3 {
        return Err(anyhow::anyhow!("Polygon must have at least 3 points"));
    }
    
    Ok(Polygon {
        outer_ring,
        holes,
        fill_color,
    })
}

/// Parse pad stack definitions and extract hole information
/// Returns a map of pad stack name -> hole definition
fn parse_padstack_definitions(root: &XmlNode) -> IndexMap<String, PadStackHole> {
    let mut padstack_defs = IndexMap::new();
    
    // Find Content -> DictionaryStandard for pad stack definitions
    if let Some(content) = root.children.iter().find(|n| n.name == "Content") {
        // Look for Step nodes which contain PadStackDef
        for step in &content.children {
            if step.name == "Step" {
                for child in &step.children {
                    if child.name == "PadStackDef" {
                        if let Some(name) = child.attributes.get("name") {
                            // Find PadstackHoleDef
                            for hole_def in &child.children {
                                if hole_def.name == "PadstackHoleDef" {
                                    let diameter = hole_def
                                        .attributes
                                        .get("diameter")
                                        .and_then(|d| d.parse::<f32>().ok())
                                        .unwrap_or(0.0);
                                    
                                    let x = hole_def
                                        .attributes
                                        .get("x")
                                        .and_then(|v| v.parse::<f32>().ok())
                                        .unwrap_or(0.0);
                                    
                                    let y = hole_def
                                        .attributes
                                        .get("y")
                                        .and_then(|v| v.parse::<f32>().ok())
                                        .unwrap_or(0.0);
                                    
                                    // Estimate ring width from pad definitions (simplified)
                                    // In full implementation, would parse PadstackPadDef
                                    let ring_width = diameter * 0.2; // Assume 20% annular ring
                                    
                                    padstack_defs.insert(
                                        name.clone(),
                                        PadStackHole {
                                            x,
                                            y,
                                            hole_diameter: diameter,
                                            ring_width,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    padstack_defs
}

/// Parse DictionaryLineDesc to extract line width and end style for each line ID
fn parse_line_descriptors(root: &XmlNode) -> IndexMap<String, LineDescriptor> {
    let mut line_descriptors = IndexMap::new();

    // Find Content node
    if let Some(content_node) = root.children.iter().find(|n| n.name == "Content") {
        // Find DictionaryLineDesc
        if let Some(dict_node) = content_node
            .children
            .iter()
            .find(|n| n.name == "DictionaryLineDesc")
        {
            // Process each EntryLineDesc
            for entry in &dict_node.children {
                if entry.name == "EntryLineDesc" {
                    if let Some(id) = entry.attributes.get("id") {
                        // Find LineDesc child
                        if let Some(line_desc) = entry.children.iter().find(|n| n.name == "LineDesc")
                        {
                            let line_width = line_desc
                                .attributes
                                .get("lineWidth")
                                .and_then(|w| w.parse::<f32>().ok())
                                .unwrap_or(0.1);

                            let line_end = line_desc
                                .attributes
                                .get("lineEnd")
                                .map(|s| parse_line_end(s))
                                .unwrap_or(LineEnd::Round);

                            line_descriptors.insert(
                                id.clone(),
                                LineDescriptor {
                                    line_width,
                                    line_end,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    line_descriptors
}

/// Parse color from attributes
fn parse_color(attrs: &IndexMap<String, String>) -> Option<[f32; 4]> {
    let r = attrs.get("r").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let g = attrs.get("g").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let b = attrs.get("b").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let a = attrs
        .get("a")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(255.0) / 255.0;
    Some([r, g, b, a])
}

/// Douglas-Peucker polyline simplification
/// Reduces number of points while maintaining shape within tolerance
fn douglas_peucker(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let mut dmax = 0.0;
    let mut index = 0;
    
    // Find the point with maximum distance from line segment
    for i in 1..points.len() - 1 {
        let d = point_line_distance(points[i], points[0], points[points.len() - 1]);
        if d > dmax {
            dmax = d;
            index = i;
        }
    }

    if dmax > tolerance {
        let mut left = douglas_peucker(&points[0..=index], tolerance);
        let right = douglas_peucker(&points[index..], tolerance);
        left.pop(); // Remove duplicate point
        left.extend(right);
        left
    } else {
        vec![points[0], points[points.len() - 1]]
    }
}

/// Calculate perpendicular distance from point to line segment
fn point_line_distance(p: Point, a: Point, b: Point) -> f32 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len_sq = dx * dx + dy * dy;
    
    if len_sq < 1e-10 {
        return ((p.x - a.x).powi(2) + (p.y - a.y).powi(2)).sqrt();
    }
    
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len_sq;
    let t = t.clamp(0.0, 1.0);
    
    let proj_x = a.x + t * dx;
    let proj_y = a.y + t * dy;
    
    ((p.x - proj_x).powi(2) + (p.y - proj_y).powi(2)).sqrt()
}

/// Generate 5 LOD levels for a single polyline using Douglas-Peucker
fn generate_polyline_lods(polyline: &Polyline) -> Vec<Vec<Point>> {
    if polyline.points.len() < 2 {
        return vec![vec![]];
    }

    let mut lods = vec![polyline.points.clone()]; // LOD0: exact

    // Calculate bounding box for tolerance scaling
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
    );
    
    for p in &polyline.points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }

    let dx = max_x - min_x;
    let dy = max_y - min_y;
    let diag = (dx * dx + dy * dy).sqrt().max(1.0);
    
    // For very short polylines (dots, small circles), limit simplification
    // to preserve their shape at all LODs
    let is_very_short = diag < polyline.width * 3.0;
    
    // CRITICAL: For polylines with many points in a small area (circles/dots),
    // don't simplify at all - keep original points at all LODs to preserve roundness
    let is_circle_or_dot = polyline.points.len() > 4 && is_very_short;
    
    if is_circle_or_dot {
        // Preserve exact geometry for circles/dots at all LODs
        for _ in 1..5 {
            lods.push(polyline.points.clone());
        }
        return lods;
    }

    // Base tolerance as fraction of bounding box diagonal
    let base_tol = diag * 0.0005;
    let max_tol = if is_very_short {
        // For dots/short segments, use much tighter max tolerance
        diag * 0.005
    } else {
        diag * 0.02
    };

    // Generate LOD1-4 with increasing tolerance (~4x each level)
    let mut tolerance = base_tol;
    for _ in 1..5 {
        if tolerance > max_tol {
            tolerance = max_tol;
        }
        let simplified = douglas_peucker(&polyline.points, tolerance);
        lods.push(simplified);
        tolerance *= 4.0;
    }

    lods
}

/// Number of segments used for round caps (matching Polyline.js defaults)
const ROUND_CAP_SEGMENTS: u32 = 16;
/// Minimum screen-space width (in world units) below which we cull geometry at higher LODs
/// Constant 0.5px screen-space threshold across all LOD levels
/// LOD zoom ranges: LOD0(10+), LOD1(5-10), LOD2(2-5), LOD3(0.5-2), LOD4(<0.5)
/// Formula: world_width_threshold = 0.5px / zoom_level
const MIN_VISIBLE_WIDTH_LOD: [f32; 5] = [
    0.0,    // LOD0: always render (zoom >= 10, highest detail)
    0.05,   // LOD1: 0.5px / 10 = 0.05mm (zoom ~10)
    0.10,   // LOD2: 0.5px / 5 = 0.10mm (zoom ~5)
    0.25,   // LOD3: 0.5px / 2 = 0.25mm (zoom ~2)
    1.00,   // LOD4: 0.5px / 0.5 = 1.00mm (zoom ~0.5)
];

/// Helper function to add a round cap at a specific position
fn add_round_cap(
    verts: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    center: Point,
    direction: (f32, f32),
    half_width: f32,
    is_start: bool,
) {
    let fan_base = (verts.len() / 2) as u32;
    verts.push(center.x);
    verts.push(center.y);
    
    let base_angle = direction.1.atan2(direction.0);
    let angle_offset = if is_start {
        std::f32::consts::PI / 2.0
    } else {
        -std::f32::consts::PI / 2.0
    };
    
    for i in 0..=ROUND_CAP_SEGMENTS {
        let t = i as f32 / ROUND_CAP_SEGMENTS as f32;
        let ang = base_angle + angle_offset + t * std::f32::consts::PI;
        verts.push(center.x + ang.cos() * half_width);
        verts.push(center.y + ang.sin() * half_width);
    }
    
    for i in 0..ROUND_CAP_SEGMENTS {
        indices.push(fan_base);
        indices.push(fan_base + 1 + i);
        indices.push(fan_base + 2 + i);
    }
}

/// Stroke a single polyline into vertex and index arrays
/// Creates triangles for the line width with miter joins connecting segments
/// Supports different line end styles (round, square, butt)
fn tessellate_polyline(points: &[Point], width: f32, line_end: LineEnd) -> (Vec<f32>, Vec<u32>) {
    let mut verts = Vec::new();
    let mut indices = Vec::new();

    if points.len() < 2 || width <= 0.0 {
        return (verts, indices);
    }

    let mut work_points = points.to_vec();
    let mut is_closed = false;

    if work_points.len() >= 3 {
        if let (Some(first), Some(last)) = (work_points.first().copied(), work_points.last().copied()) {
            let close_thresh = 1e-4;
            if (first.x - last.x).abs() < close_thresh && (first.y - last.y).abs() < close_thresh {
                is_closed = true;
                work_points.pop();
            }
        }
    }

    if work_points.len() < 2 {
        return (verts, indices);
    }

    let n = work_points.len();
    let half_w = width * 0.5;
    let segment_count = if is_closed { n } else { n - 1 };

    let mut seg_dir = Vec::with_capacity(segment_count);
    let mut seg_norm = Vec::with_capacity(segment_count);

    for i in 0..segment_count {
        let p0 = work_points[i];
        let p1 = work_points[(i + 1) % n];
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        let len = (dx * dx + dy * dy).sqrt();

        if len < 1e-12 {
            seg_dir.push((1.0, 0.0));
            seg_norm.push((0.0, 1.0));
        } else {
            let inv_len = 1.0 / len;
            let dx_norm = dx * inv_len;
            let dy_norm = dy * inv_len;
            seg_dir.push((dx_norm, dy_norm));
            seg_norm.push((-dy_norm, dx_norm));
        }
    }

    let pair_from = |point: Point, normal: (f32, f32)| -> (Point, Point) {
        (
            Point {
                x: point.x + normal.0 * half_w,
                y: point.y + normal.1 * half_w,
            },
            Point {
                x: point.x - normal.0 * half_w,
                y: point.y - normal.1 * half_w,
            },
        )
    };

    let mut pairs: Vec<(Point, Point)> = Vec::new();
    pairs.push(pair_from(work_points[0], seg_norm[0]));

    for i in 0..segment_count {
        let end_idx = if i + 1 < n { i + 1 } else { 0 };
        let curr_norm = seg_norm[i];
        let end_pair = pair_from(work_points[end_idx], curr_norm);
        pairs.push(end_pair);

        if !is_closed && i == segment_count - 1 {
            continue;
        }

        let next_norm = seg_norm[(i + 1) % segment_count];
        let curr_dir = seg_dir[i];
        let next_dir = seg_dir[(i + 1) % segment_count];
        let cross = curr_dir.0 * next_dir.1 - curr_dir.1 * next_dir.0;

        if cross.abs() < 1e-6 {
            continue;
        }

        let is_left_turn = cross > 0.0;
        let center = work_points[end_idx];
        let next_pair = pair_from(center, next_norm);

        let (outer_start, outer_end, inner_start, inner_end) = if is_left_turn {
            (end_pair.0, next_pair.0, end_pair.1, next_pair.1)
        } else {
            (end_pair.1, next_pair.1, end_pair.0, next_pair.0)
        };

        let start_angle = (outer_start.y - center.y).atan2(outer_start.x - center.x);
        let end_angle = (outer_end.y - center.y).atan2(outer_end.x - center.x);
        let mut sweep = end_angle - start_angle;

        if is_left_turn {
            while sweep <= 0.0 {
                sweep += std::f32::consts::PI * 2.0;
            }
        } else {
            while sweep >= 0.0 {
                sweep -= std::f32::consts::PI * 2.0;
            }
        }

        let angle_span = sweep.abs();
        let segments = (angle_span / (std::f32::consts::PI / 18.0)).ceil() as u32;
        let num_segs = segments.max(4);

        for s in 1..=num_segs {
            let t = s as f32 / num_segs as f32;
            let ang = start_angle + sweep * t;
            let outer_point = Point {
                x: center.x + ang.cos() * half_w,
                y: center.y + ang.sin() * half_w,
            };
            let inner_point = Point {
                x: inner_start.x + (inner_end.x - inner_start.x) * t,
                y: inner_start.y + (inner_end.y - inner_start.y) * t,
            };

            if is_left_turn {
                pairs.push((outer_point, inner_point));
            } else {
                pairs.push((inner_point, outer_point));
            }
        }
    }

    for pair in &pairs {
        verts.push(pair.0.x);
        verts.push(pair.0.y);
        verts.push(pair.1.x);
        verts.push(pair.1.y);
    }

    let base_pairs = pairs.len();
    let segment_pairs = if is_closed { base_pairs } else { base_pairs.saturating_sub(1) };

    for i in 0..segment_pairs {
        let next = if i + 1 < base_pairs { i + 1 } else { 0 };
        if !is_closed && next == 0 {
            continue;
        }
        let base = (i * 2) as u32;
        let next_base = (next * 2) as u32;
        indices.push(base);
        indices.push(next_base);
        indices.push(next_base + 1);
        indices.push(base);
        indices.push(next_base + 1);
        indices.push(base + 1);
    }

    if !is_closed {
        match line_end {
            LineEnd::Round => {
                add_round_cap(
                    &mut verts,
                    &mut indices,
                    work_points[0],
                    seg_dir[0],
                    half_w,
                    true,
                );
                add_round_cap(
                    &mut verts,
                    &mut indices,
                    work_points[n - 1],
                    seg_dir[segment_count - 1],
                    half_w,
                    false,
                );
            }
            LineEnd::Square => {
                let start_pair = pairs[0];
                let end_pair = pairs[pairs.len() - 1];
                let start_dir = seg_dir[0];
                let end_dir = seg_dir[segment_count - 1];

                let s_shift_x = -start_dir.0 * half_w;
                let s_shift_y = -start_dir.1 * half_w;
                let v_start = (verts.len() / 2) as u32;
                verts.push(start_pair.0.x + s_shift_x);
                verts.push(start_pair.0.y + s_shift_y);
                verts.push(start_pair.1.x + s_shift_x);
                verts.push(start_pair.1.y + s_shift_y);
                indices.push(v_start);
                indices.push(0);
                indices.push(1);
                indices.push(v_start);
                indices.push(1);
                indices.push(v_start + 1);

                let e_shift_x = end_dir.0 * half_w;
                let e_shift_y = end_dir.1 * half_w;
                let v_end = (verts.len() / 2) as u32;
                let last_base = ((pairs.len() - 1) * 2) as u32;
                verts.push(end_pair.0.x + e_shift_x);
                verts.push(end_pair.0.y + e_shift_y);
                verts.push(end_pair.1.x + e_shift_x);
                verts.push(end_pair.1.y + e_shift_y);
                indices.push(last_base);
                indices.push(v_end);
                indices.push(v_end + 1);
                indices.push(last_base);
                indices.push(v_end + 1);
                indices.push(last_base + 1);
            }
            LineEnd::Butt => {}
        }
    }

    (verts, indices)
}

/// Batch all polylines for a layer into a single vertex/index buffer
/// Each polyline maintains its own width and line_end style
fn batch_polylines_with_styles(
    polylines_data: &[(Vec<Point>, f32, LineEnd)],
) -> (Vec<f32>, Vec<u32>) {
    let mut all_verts = Vec::new();
    let mut all_indices = Vec::new();

    for (points, width, line_end) in polylines_data {
        let (verts, mut indices) = tessellate_polyline(points, *width, *line_end);
        
        // Offset indices by current vertex count
        let vert_offset = all_verts.len() as u32 / 2;
        for idx in indices.iter_mut() {
            *idx += vert_offset;
        }
        
        all_verts.extend(verts);
        all_indices.extend(indices);
    }

    (all_verts, all_indices)
}

/// Tessellate a filled polygon using earcut triangulation
/// Supports outer ring + optional holes with LOD via Douglas-Peucker
/// Returns (vertices, indices) as flat arrays
fn tessellate_polygon(polygon: &Polygon, tolerance: f32) -> (Vec<f32>, Vec<u32>) {
    // Simplify outer ring and holes using Douglas-Peucker
    let simplified_outer = if tolerance > 0.0 {
        douglas_peucker(&polygon.outer_ring, tolerance)
    } else {
        polygon.outer_ring.clone()
    };
    
    let simplified_holes: Vec<Vec<Point>> = polygon.holes.iter()
        .map(|hole| {
            if tolerance > 0.0 {
                douglas_peucker(hole, tolerance)
            } else {
                hole.clone()
            }
        })
        .collect();
    
    // Build flat coordinate array for earcut
    let mut flat_coords: Vec<f64> = Vec::new();
    let mut hole_indices: Vec<usize> = Vec::new();
    
    // Add outer ring
    for p in &simplified_outer {
        flat_coords.push(p.x as f64);
        flat_coords.push(p.y as f64);
    }
    
    // Add holes
    for hole in &simplified_holes {
        if hole.len() < 3 {
            continue; // Skip degenerate holes
        }
        hole_indices.push(flat_coords.len() / 2);
        for p in hole {
            flat_coords.push(p.x as f64);
            flat_coords.push(p.y as f64);
        }
    }
    
    // Triangulate using earcut
    let indices = earcutr::earcut(&flat_coords, &hole_indices, 2);
    
    // Convert to f32 for GPU
    let vertices: Vec<f32> = flat_coords.iter().map(|&v| v as f32).collect();
    let indices_u32: Vec<u32> = indices.unwrap_or_default().iter().map(|&i| i as u32).collect();
    
    (vertices, indices_u32)
}

/// Generate LODs for a polygon using Douglas-Peucker simplification
/// Returns array of LODs with progressively higher tolerance
fn generate_polygon_lods(polygon: &Polygon) -> Vec<(Vec<f32>, Vec<u32>)> {
    // Compute bounding box diagonal for tolerance scaling
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    
    for p in &polygon.outer_ring {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    
    let diag = ((max_x - min_x).powi(2) + (max_y - min_y).powi(2)).sqrt().max(1.0);
    let base_tol = diag * 0.0005;
    let max_tol = diag * 0.02;
    
    // Generate tolerance levels (similar to Polygon.js)
    let mut tolerances = vec![0.0]; // LOD0: original
    while tolerances.len() < 6 && tolerances[tolerances.len() - 1] < max_tol {
        let next = if tolerances.len() == 1 {
            base_tol
        } else {
            (tolerances[tolerances.len() - 1] * 4.0).min(max_tol)
        };
        tolerances.push(next);
    }
    
    // Generate LOD geometries
    tolerances.iter()
        .map(|&tol| tessellate_polygon(polygon, tol))
        .collect()
}

/// Tessellate pad stack holes with optional annular rings
/// Groups holes by size for LOD optimization (matching PadStackHoleBatch.js)
/// Returns separate geometry for rings and holes
fn tessellate_padstack_holes(
    holes: &[PadStackHole],
    segments: u32,
) -> (Vec<f32>, Vec<u32>, Vec<f32>, Vec<u32>) {
    let seg = segments.max(8); // Minimum 8 segments for smooth circles
    
    let mut ring_verts = Vec::new();
    let mut ring_indices = Vec::new();
    let mut hole_verts = Vec::new();
    let mut hole_indices = Vec::new();
    
    let mut ring_vertex_base = 0u32;
    let mut hole_vertex_base = 0u32;
    
    for pad in holes {
        let hole_r = pad.hole_diameter * 0.5;
        let outer_r = hole_r + pad.ring_width;
        
        // Generate annular ring if ring_width > 0
        if pad.ring_width > 0.0 {
            for i in 0..=seg {
                let angle = (i as f32 / seg as f32) * std::f32::consts::PI * 2.0;
                let cos_a = angle.cos();
                let sin_a = angle.sin();
                
                // Outer vertex
                ring_verts.push(pad.x + cos_a * outer_r);
                ring_verts.push(pad.y + sin_a * outer_r);
                
                // Inner vertex
                ring_verts.push(pad.x + cos_a * hole_r);
                ring_verts.push(pad.y + sin_a * hole_r);
            }
            
            // Generate quad indices for ring
            for i in 0..seg {
                let o = ring_vertex_base + i * 2;
                ring_indices.extend_from_slice(&[
                    o, o + 1, o + 2,
                    o + 2, o + 1, o + 3,
                ]);
            }
            
            ring_vertex_base += (seg + 1) * 2;
        }
        
        // Generate hole as triangle fan (always present)
        let center_index = hole_vertex_base;
        hole_verts.push(pad.x);
        hole_verts.push(pad.y);
        hole_vertex_base += 1;
        
        for i in 0..=seg {
            let angle = (i as f32 / seg as f32) * std::f32::consts::PI * 2.0;
            hole_verts.push(pad.x + angle.cos() * hole_r);
            hole_verts.push(pad.y + angle.sin() * hole_r);
            hole_vertex_base += 1;
        }
        
        // Triangle fan indices
        for i in 0..seg {
            hole_indices.extend_from_slice(&[
                center_index,
                center_index + 1 + i,
                center_index + 1 + i + 1,
            ]);
        }
    }
    
    (ring_verts, ring_indices, hole_verts, hole_indices)
}

fn should_debug_layer(layer_id: &str) -> bool {
    match env::var("DEBUG_TESSELLATION_LAYER") {
        Ok(val) => {
            if val.trim().is_empty() {
                true
            } else {
                val.split(',').any(|entry| entry.trim() == layer_id)
            }
        }
        Err(_) => false,
    }
}

fn debug_print_polyline(
    layer_id: &str,
    points: &[Point],
    width: f32,
    line_end: LineEnd,
) {
    let (verts, indices) = tessellate_polyline(points, width, line_end);
    println!(
        "\nPolyline: {} points, width: {:.3}, layer: {}",
        points.len(),
        width,
        layer_id
    );
    println!(
        " Generated: {} triangles ({} vertices)",
        indices.len() / 3,
        verts.len() / 2
    );

    let mut vertex_pairs = Vec::with_capacity(verts.len() / 2);
    for chunk in verts.chunks_exact(2) {
        vertex_pairs.push((chunk[0], chunk[1]));
    }

    for (tri_idx, tri) in indices.chunks_exact(3).enumerate() {
        if tri_idx >= 200 {
            break;
        }
        let v0 = vertex_pairs[tri[0] as usize];
        let v1 = vertex_pairs[tri[1] as usize];
        let v2 = vertex_pairs[tri[2] as usize];
        println!(
            " Triangle {}: [{:.3}, {:.3}], [{:.3}, {:.3}], [{:.3}, {:.3}]",
            tri_idx, v0.0, v0.1, v1.0, v1.1, v2.0, v2.1
        );
    }
}

/// Generate LayerJSON for all geometry types (polylines, polygons, pad stacks) in a layer
pub fn generate_layer_json(
    layer_id: &str,
    layer_name: &str,
    color: [f32; 4],
    geometries: &LayerGeometries,
    culling_stats: &mut CullingStats,
) -> Result<LayerJSON, anyhow::Error> {
    let layer_start = std::time::Instant::now();
    
    // Generate polyline geometry (opaque, no alpha) - for batch.wgsl
    let polyline_lods = if !geometries.polylines.is_empty() {
        generate_polyline_geometry(layer_id, layer_name, &geometries.polylines, culling_stats)?
    } else {
        Vec::new()
    };
    
    // Generate polygon geometry (with alpha) - for batch_colored.wgsl
    let polygon_lods = if !geometries.polygons.is_empty() {
        if std::env::var("PROFILE_TIMING").is_ok() {
            println!("    [{}] Processing {} polygons", layer_name, geometries.polygons.len());
        }
        let lods = generate_polygon_geometry(&geometries.polygons)?;
        if std::env::var("PROFILE_TIMING").is_ok() && !lods.is_empty() {
            println!("    [{}] Generated {} polygon LODs with {} vertices", 
                layer_name, lods.len(), lods[0].vertex_count);
        }
        lods
    } else {
        Vec::new()
    };
    
    // TODO: Add pad stack holes similarly with alpha for rings vs holes
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("    [{}] Total layer time: {:.2}ms\n", layer_name, layer_start.elapsed().as_secs_f64() * 1000.0);
    }
    
    let mut shader_geom = ShaderGeometry::default();
    shader_geom.batch = if polyline_lods.is_empty() {
        None
    } else {
        Some(polyline_lods)
    };
    shader_geom.batch_colored = if polygon_lods.is_empty() {
        None
    } else {
        Some(polygon_lods)
    };
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("    [{}] ShaderGeometry: batch={}, batch_colored={}", 
            layer_name, 
            shader_geom.batch.is_some(),
            shader_geom.batch_colored.is_some());
        
        // Debug: serialize and check JSON output
        if let Ok(json_str) = serde_json::to_string(&shader_geom) {
            let has_batch_colored = json_str.contains("batch_colored");
            println!("    [{}] JSON contains batch_colored: {}", layer_name, has_batch_colored);
            if !has_batch_colored && shader_geom.batch_colored.is_some() {
                println!("    [{}] WARNING: batch_colored is Some but not in JSON!", layer_name);
            }
        }
    }

    Ok(LayerJSON {
        layer_id: layer_id.to_string(),
        layer_name: layer_name.to_string(),
        default_color: color,
        geometry: shader_geom,
    })
}

/// Generate polyline LOD geometry (extracted from original generate_layer_json)
fn generate_polyline_geometry(
    layer_id: &str,
    layer_name: &str,
    polylines: &[Polyline],
    culling_stats: &mut CullingStats,
) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    let mut lod_geometries: Vec<GeometryLOD> = Vec::new();

    // Generate LODs for all polylines
    let lod_gen_start = std::time::Instant::now();
    let mut all_lod_points: Vec<Vec<Vec<Point>>> = Vec::new();
    
    for polyline in polylines {
        let lods = generate_polyline_lods(polyline);
        all_lod_points.push(lods);
    }
    let lod_gen_time = lod_gen_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("    [{}] LOD generation: {:.2}ms ({} polylines)",
                 layer_name, lod_gen_time.as_secs_f64() * 1000.0, polylines.len());
    }

    // For each LOD level, batch all polylines at that LOD
    let batch_start = std::time::Instant::now();
    let debug_this_layer = should_debug_layer(layer_id);
    let mut debug_header_printed = false;
    culling_stats.total_polylines += polylines.len();
    
    for lod_idx in 0..5 {
        let mut lod_polylines_data = Vec::new();
        let min_width = MIN_VISIBLE_WIDTH_LOD[lod_idx];
        
        for (poly_idx, polyline) in polylines.iter().enumerate() {
            if poly_idx < all_lod_points.len() && lod_idx < all_lod_points[poly_idx].len() {
                // Skip tessellation if line is too thin to be visible at this LOD
                if polyline.width < min_width {
                    culling_stats.lod_culled[lod_idx] += 1;
                    continue;
                }
                
                // Width-dependent LOD cap optimization:
                // - Thin lines (< 0.05): butt caps from LOD 1+
                // - Medium lines (0.05-0.2): butt caps from LOD 2+
                // - Thick lines (> 0.2): butt caps from LOD 3+
                let butt_lod_threshold = if polyline.width < 0.05 {
                    1
                } else if polyline.width < 0.2 {
                    2
                } else {
                    3
                };
                
                let effective_line_end = if lod_idx >= butt_lod_threshold && polyline.line_end != LineEnd::Butt {
                    LineEnd::Butt
                } else {
                    polyline.line_end
                };
                
                let lod_points = all_lod_points[poly_idx][lod_idx].clone();
                if debug_this_layer && lod_idx == 0 {
                    if !debug_header_printed {
                        println!(
                            "\n=== {} Polyline Tessellation (first 200 triangles) ===",
                            layer_name
                        );
                        println!(
                            " Total {} polylines: {}",
                            layer_name,
                            polylines.len()
                        );
                        debug_header_printed = true;
                    }
                    debug_print_polyline(
                        layer_id,
                        &lod_points,
                        polyline.width,
                        effective_line_end,
                    );
                }
                lod_polylines_data.push((lod_points, polyline.width, effective_line_end));
            }
        }

        if lod_polylines_data.is_empty() {
            continue;
        }

        // Batch all polylines at this LOD into single vertex/index buffer
        let tessellate_start = std::time::Instant::now();
        let (verts, indices) = batch_polylines_with_styles(&lod_polylines_data);
        let tessellate_time = tessellate_start.elapsed();
        
        if std::env::var("PROFILE_TIMING").is_ok() && !lod_polylines_data.is_empty() {
            println!("      LOD{}: tessellation {:.2}ms ({} polylines -> {} verts, {} indices)",
                     lod_idx, tessellate_time.as_secs_f64() * 1000.0,
                     lod_polylines_data.len(), verts.len() / 2, indices.len());
        }

        if verts.is_empty() || indices.is_empty() {
            continue;
        }

        let vertex_count = verts.len() / 2;
        let index_count = indices.len();
        
        let geometry_lod = GeometryLOD {
            vertex_data: verts,
            vertex_count,
            index_data: Some(indices),
            index_count: Some(index_count),
            alpha_data: None, // Will be added later in generate_layer_json
        };

        lod_geometries.push(geometry_lod);
    }

    if debug_this_layer && debug_header_printed {
        println!(
            "=== End of {} Tessellation (200 triangles shown) ===",
            layer_name
        );
        // Report culling stats
        let total = polylines.len();
        for (lod, count) in culling_stats.lod_culled.iter().enumerate() {
            if *count > 0 {
                println!(
                    "  LOD{}: culled {}/{} polylines (width < {:.3})",
                    lod, count, total, MIN_VISIBLE_WIDTH_LOD[lod]
                );
            }
        }
    }

    let batch_time = batch_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("    [{}] Batching/tessellation: {:.2}ms", layer_name, batch_time.as_secs_f64() * 1000.0);
    }
    
    Ok(lod_geometries)
}

/// Generate polygon LOD geometry using earcut triangulation
fn generate_polygon_geometry(polygons: &[Polygon]) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    // Batch all polygons into single vertex/index buffer
    let mut all_verts = Vec::new();
    let mut all_indices = Vec::new();
    
    for polygon in polygons {
        let (verts, indices) = tessellate_polygon(polygon, 0.0); // LOD0: no simplification
        
        // Offset indices by current vertex count
        let vert_offset = (all_verts.len() / 2) as u32;
        all_verts.extend(verts);
        all_indices.extend(indices.iter().map(|&i| i + vert_offset));
    }
    
    if all_verts.is_empty() || all_indices.is_empty() {
        return Ok(Vec::new());
    }
    
    // Create single LOD level with alpha from polygon fill colors
    let vert_count = all_verts.len() / 2;
    let index_count = all_indices.len();
    
    // Extract alpha values from polygon fill colors
    let mut alpha_values = Vec::with_capacity(vert_count);
    for polygon in polygons {
        let (verts, _) = tessellate_polygon(polygon, 0.0);
        let poly_vert_count = verts.len() / 2;
        let alpha = polygon.fill_color[3]; // Use alpha from fill_color
        alpha_values.extend(vec![alpha; poly_vert_count]);
    }
    
    let geometry_lod = GeometryLOD {
        vertex_data: all_verts,
        vertex_count: vert_count,
        index_data: Some(all_indices),
        index_count: Some(index_count),
        alpha_data: Some(alpha_values),
    };
    
    Ok(vec![geometry_lod])
}

/// Generate pad stack hole geometry (rings + holes)
fn generate_padstack_geometry(holes: &[PadStackHole]) -> Result<Vec<GeometryLOD>, anyhow::Error> {
    let segments = 24; // Smooth circles
    let (ring_verts, ring_indices, hole_verts, hole_indices) = 
        tessellate_padstack_holes(holes, segments);
    
    // Combine rings and holes into single geometry
    // Draw order: rings first (with color), then holes (black) to mask centers
    let mut combined_verts = ring_verts;
    let mut combined_indices = ring_indices;
    let vert_count_before_holes = combined_verts.len() / 2;
    
    // Calculate hole vert count before moving
    let hole_vert_count = hole_verts.len() / 2;
    
    // Offset hole indices by ring vertex count
    let vert_offset = vert_count_before_holes as u32;
    combined_verts.extend(hole_verts);
    combined_indices.extend(hole_indices.iter().map(|&i| i + vert_offset));
    let total_index_count = combined_indices.len();
    
    if combined_verts.is_empty() || combined_indices.is_empty() {
        return Ok(Vec::new());
    }
    
    let geometry_lod = GeometryLOD {
        vertex_data: combined_verts,
        vertex_count: vert_count_before_holes + hole_vert_count,
        index_data: Some(combined_indices),
        index_count: Some(total_index_count),
        alpha_data: None, // Pad stacks are opaque
    };
    
    Ok(vec![geometry_lod]) // Single LOD for now
}

/// Extract all LayerFeatures from XML root and generate LayerJSON for each
pub fn extract_and_generate_layers(root: &XmlNode) -> Result<Vec<LayerJSON>, anyhow::Error> {
    let total_start = std::time::Instant::now();
    let mut layer_jsons = Vec::new();
    let mut layers_seen = std::collections::HashSet::new();
    let mut total_culling_stats = CullingStats::default();

    // Parse line descriptors from DictionaryLineDesc
    let parse_start = std::time::Instant::now();
    let line_descriptors = parse_line_descriptors(root);
    let parse_time = parse_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("\n=== Detailed Timing Profile ===");
        println!("Line descriptor parsing: {:.2}ms", parse_time.as_secs_f64() * 1000.0);
    }

    // Find Ecad node which contains all the CAD data
    let ecad_node = root
        .children
        .iter()
        .find(|n| n.name == "Ecad")
        .ok_or_else(|| anyhow::anyhow!("No Ecad node found"))?;

    // Find CadData node within Ecad
    let cad_data = ecad_node
        .children
        .iter()
        .find(|n| n.name == "CadData")
        .ok_or_else(|| anyhow::anyhow!("No CadData node found"))?;

    // Find all LayerFeature nodes and process them
    let collect_start = std::time::Instant::now();
    collect_layer_features(cad_data, &mut layer_jsons, &mut layers_seen, &line_descriptors, &mut total_culling_stats)?;
    let collect_time = collect_start.elapsed();
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        println!("\nTotal collection time: {:.2}ms", collect_time.as_secs_f64() * 1000.0);
        println!("TOTAL TESSELLATION TIME: {:.2}ms\n", total_start.elapsed().as_secs_f64() * 1000.0);
    }

    // Print summary if we culled anything
    if total_culling_stats.lod_culled.iter().any(|&c| c > 0) {
        println!("\n=== Width-Based Culling Summary ===");
        println!("Total polylines across all layers: {}", total_culling_stats.total_polylines);
        for (lod, count) in total_culling_stats.lod_culled.iter().enumerate() {
            if *count > 0 {
                let percent = (*count as f32 / total_culling_stats.total_polylines as f32) * 100.0;
                println!(
                    "  LOD{}: {} polylines culled ({:.1}%, width < {:.3})",
                    lod, count, percent, MIN_VISIBLE_WIDTH_LOD[lod]
                );
            }
        }
    }

    Ok(layer_jsons)
}

/// Recursively find LayerFeature nodes and generate LayerJSON for each unique layer
fn collect_layer_features(
    node: &XmlNode,
    layer_jsons: &mut Vec<LayerJSON>,
    layers_seen: &mut std::collections::HashSet<String>,
    line_descriptors: &IndexMap<String, LineDescriptor>,
    culling_stats: &mut CullingStats,
) -> Result<(), anyhow::Error> {
    // If this is a LayerFeature node, process it
    if node.name == "LayerFeature" {
        if let Some(layer_ref) = node.attributes.get("layerRef") {
            if !layers_seen.contains(layer_ref) {
                layers_seen.insert(layer_ref.clone());
                
                // Collect all geometries from this LayerFeature
                let mut geometries = LayerGeometries {
                    layer_ref: layer_ref.clone(),
                    polylines: Vec::new(),
                    polygons: Vec::new(),
                    padstack_holes: Vec::new(),
                };
                collect_geometries_from_node(node, &mut geometries, line_descriptors);
                
                // Only generate layer if it has any geometry
                if !geometries.polylines.is_empty() || !geometries.polygons.is_empty() || !geometries.padstack_holes.is_empty() {
                    // Extract layer name from layerRef (e.g., "LAYER:Design" -> "Design")
                    let layer_name = layer_ref
                        .split(':')
                        .next_back()
                        .unwrap_or(layer_ref)
                        .to_string();
                    
                    // Generate default color based on layer type
                    let color = get_layer_color(layer_ref);
                    
                    let layer_json = generate_layer_json(
                        layer_ref,
                        &layer_name,
                        color,
                        &geometries,
                        culling_stats,
                    )?;
                    
                    layer_jsons.push(layer_json);
                }
            }
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_layer_features(child, layer_jsons, layers_seen, line_descriptors, culling_stats)?;
    }

    Ok(())
}

/// Get a color for a layer based on its name/type
fn get_layer_color(layer_ref: &str) -> [f32; 4] {
    let lower = layer_ref.to_lowercase();
    
    // Top silkscreen: pure gray
    if (lower.contains("silkscreen") || lower.contains("silk")) && lower.contains("f.") {
        return [0.7, 0.7, 0.7, 1.0]; // Gray
    }
    
    // Bottom silkscreen: yellowish tinted gray
    if (lower.contains("silkscreen") || lower.contains("silk")) && lower.contains("b.") {
        return [0.75, 0.73, 0.6, 1.0]; // Yellowish gray
    }
    
    // Very distinct colors for other layers: top layers red, bottom layers blue
    if lower.contains("f.") {
        // Front/Top layers - reds to oranges
        if lower.contains(".cu") || lower.contains("copper") {
            return [1.0, 0.2, 0.2, 1.0]; // Bright red
        } else if lower.contains("paste") {
            return [1.0, 0.5, 0.5, 1.0]; // Light red
        } else if lower.contains("mask") {
            return [0.8, 0.0, 0.0, 1.0]; // Dark red
        } else {
            return [1.0, 0.3, 0.0, 1.0]; // Orange-red
        }
    } else if lower.contains("b.") {
        // Back/Bottom layers - blues to cyans
        if lower.contains(".cu") || lower.contains("copper") {
            return [0.2, 0.2, 1.0, 1.0]; // Bright blue
        } else if lower.contains("paste") {
            return [0.5, 0.5, 1.0, 1.0]; // Light blue
        } else if lower.contains("mask") {
            return [0.0, 0.0, 0.8, 1.0]; // Dark blue
        } else {
            return [0.0, 0.5, 1.0, 1.0]; // Cyan-blue
        }
    }
    
    // Internal layers and other types - greens and purples
    if lower.contains("in") || lower.contains("inner") {
        return [0.2, 1.0, 0.2, 1.0]; // Bright green
    }
    
    if lower.contains("dielectric") {
        return [0.8, 0.6, 1.0, 1.0]; // Light purple
    }
    
    // User layers - distinctive colors
    if lower.contains("user") {
        return [1.0, 1.0, 0.2, 1.0]; // Bright yellow
    }
    
    [0.7, 0.7, 0.7, 1.0] // default gray
}

/// Recursively collect all geometry elements from a specific node
fn collect_geometries_from_node(
    node: &XmlNode,
    geometries: &mut LayerGeometries,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) {
    // If this is a Polyline node, parse it
    if node.name == "Polyline" {
        if let Ok(polyline) = parse_polyline_node(node, line_descriptors) {
            geometries.polylines.push(polyline);
        }
    } else if node.name == "Line" {
        if let Ok(line_polyline) = parse_line_node(node, line_descriptors) {
            geometries.polylines.push(line_polyline);
        }
    } else if node.name == "Polygon" {
        // Parse filled polygon shapes
        if let Ok(polygon) = parse_polygon_node(node) {
            geometries.polygons.push(polygon);
        }
    }
    // Note: Pad stack holes are collected separately via parse_padstack_definitions
    // and instantiated at component locations

    // Recursively search all children
    for child in &node.children {
        collect_geometries_from_node(child, geometries, line_descriptors);
    }
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_douglas_peucker() {
        let points = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.1 },
            Point { x: 2.0, y: 0.0 },
            Point { x: 3.0, y: 1.0 },
            Point { x: 4.0, y: 0.0 },
        ];

        let simplified = douglas_peucker(&points, 0.5);
        assert!(simplified.len() <= points.len());
        assert_eq!(simplified[0].x, 0.0);
        assert_eq!(simplified[simplified.len() - 1].x, 4.0);
    }

    #[test]
    fn test_generate_lods() {
        let polyline = Polyline {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
                Point { x: 2.0, y: 0.5 },
                Point { x: 3.0, y: 1.5 },
                Point { x: 4.0, y: 0.0 },
            ],
            width: 0.1,
            color: [1.0, 0.0, 0.0, 1.0],
            line_end: LineEnd::Round,
        };

        let lods = generate_polyline_lods(&polyline);
        assert_eq!(lods.len(), 5);
        assert_eq!(lods[0].len(), polyline.points.len()); // LOD0 is exact
        for i in 1..5 {
            assert!(lods[i].len() <= lods[i - 1].len()); // Each LOD has fewer or equal points
        }
    }

    #[test]
    fn test_tessellate_polyline() {
        let points = vec![Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 0.0 }];
        let (verts, indices) = tessellate_polyline(&points, 0.1, LineEnd::Round);
        
        assert!(verts.len() >= 8); // At least 4 vertices (2 per quad)
        assert!(indices.len() >= 6); // At least 6 indices (2 triangles)
    }

    #[test]
    fn test_geometry_lod_serialization() {
        let data: Vec<f32> = vec![1.0, 2.0, 3.0, 4.0];
        let lod = GeometryLOD {
            vertex_data: data.clone(),
            vertex_count: 2,
            index_data: Some(vec![0, 1, 2]),
            index_count: Some(3),
            alpha_data: None,
        };
        let json = serde_json::to_string(&lod).unwrap();
        assert!(json.contains("vertexData"));
        assert!(json.contains("vertexCount"));
    }

    #[test]
    fn test_parse_line_end() {
        assert_eq!(parse_line_end("ROUND"), LineEnd::Round);
        assert_eq!(parse_line_end("round"), LineEnd::Round);
        assert_eq!(parse_line_end("SQUARE"), LineEnd::Square);
        assert_eq!(parse_line_end("BUTT"), LineEnd::Butt);
        assert_eq!(parse_line_end("unknown"), LineEnd::Round); // Default
    }

    #[test]
    fn test_tessellate_with_round_caps() {
        let points = vec![Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 0.0 }];
        let (verts, indices) = tessellate_polyline(&points, 0.1, LineEnd::Round);
        
        // Should have more vertices due to round caps
        assert!(verts.len() > 8);
        assert!(indices.len() > 6);
    }

    #[test]
    fn test_tessellate_with_square_caps() {
        let points = vec![Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 0.0 }];
        let (verts, indices) = tessellate_polyline(&points, 0.1, LineEnd::Square);
        
        // Should have extra vertices for square caps
        assert!(verts.len() >= 12); // 4 base + 4 for caps
        assert!(indices.len() >= 12); // 2 triangles for line + 2 for caps
    }
}

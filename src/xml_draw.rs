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
use serde::Serialize;

/// A 2D point
#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Represents a single polyline
#[derive(Debug, Clone)]
pub struct Polyline {
    pub points: Vec<Point>,
    pub width: f32,
    pub color: [f32; 4],
}

/// Represents all polylines organized by layer
#[derive(Debug)]
pub struct LayerPolylines {
    pub layer_ref: String,
    pub polylines: Vec<Polyline>,
}

/// Serializable geometry LOD for JSON
#[derive(Serialize)]
pub struct GeometryLOD {
    /// Base64-encoded Float32Array (x, y, x, y, ...)
    #[serde(rename = "vertexData")]
    pub vertex_data: String,
    
    /// Number of vertices (not bytes)
    #[serde(rename = "vertexCount")]
    pub vertex_count: usize,
    
    /// Optional base64-encoded Uint32Array indices
    #[serde(rename = "indexData")]
    pub index_data: Option<String>,
    
    /// Optional number of indices
    #[serde(rename = "indexCount")]
    pub index_count: Option<usize>,
}

/// Shader geometry organized by type
#[derive(Serialize, Default)]
pub struct ShaderGeometry {
    /// For batch.wgsl - many unique items in one draw
    pub batch: Option<Vec<GeometryLOD>>,
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

/// Extract polylines from a LayerFeatures XML node
#[allow(dead_code)]
fn extract_polylines_from_layer(layer_node: &XmlNode) -> Result<Vec<Polyline>, anyhow::Error> {
    let mut polylines = Vec::new();
    
    // Find all Polyline children
    for child in &layer_node.children {
        if child.name == "Polyline" {
            if let Ok(polyline) = parse_polyline_node(child) {
                polylines.push(polyline);
            }
        }
    }
    
    Ok(polylines)
}

/// Parse a single Polyline XML node
fn parse_polyline_node(node: &XmlNode) -> Result<Polyline, anyhow::Error> {
    let mut points = Vec::new();
    let width: f32 = node
        .attributes
        .get("width")
        .and_then(|w| w.parse().ok())
        .unwrap_or(0.1);
    
    // Extract color from attributes or use default
    let color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 1.0]);
    
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
            _ => {}
        }
    }
    
    Ok(Polyline { points, width, color })
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

    // Base tolerance as fraction of bounding box diagonal
    let base_tol = diag * 0.0005;
    let max_tol = diag * 0.02;

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

/// Stroke a single polyline into vertex and index arrays
/// Creates triangles for the line width with miter joins connecting segments
fn tessellate_polyline(points: &[Point], width

/// Batch all polylines for a layer into a single vertex/index buffer
fn batch_polylines(polylines: &[Vec<Point>], width: f32) -> (Vec<f32>, Vec<u32>) {
    let mut all_verts = Vec::new();
    let mut all_indices = Vec::new();

    for points in polylines {
        let (verts, mut indices) = tessellate_polyline(points, width);
        
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

/// Encode Float32Array to base64
fn encode_f32_array(data: &[f32]) -> String {
    let bytes = unsafe {
        std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 4)
    };
    base64_encode(bytes)
}

/// Encode Uint32Array to base64
fn encode_u32_array(data: &[u32]) -> String {
    let bytes = unsafe {
        std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 4)
    };
    base64_encode(bytes)
}

/// Simple base64 encoding
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        
        result.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        result.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        
        if chunk.len() > 1 {
            result.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        
        if chunk.len() > 2 {
            result.push(TABLE[(n & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    
    result
}

/// Generate LayerJSON for all LODs of polylines in a layer
pub fn generate_layer_json(
    layer_id: &str,
    layer_name: &str,
    color: [f32; 4],
    polylines: &[Polyline],
) -> Result<LayerJSON, anyhow::Error> {
    let mut lod_geometries = Vec::new();

    // Generate LODs for all polylines
    let mut all_lod_points: Vec<Vec<Vec<Point>>> = Vec::new();
    
    for polyline in polylines {
        let lods = generate_polyline_lods(polyline);
        all_lod_points.push(lods);
    }

    // For each LOD level, batch all polylines at that LOD
    for lod_idx in 0..5 {
        let mut lod_points = Vec::new();
        
        for (poly_idx, _polyline) in polylines.iter().enumerate() {
            if poly_idx < all_lod_points.len() && lod_idx < all_lod_points[poly_idx].len() {
                lod_points.push(all_lod_points[poly_idx][lod_idx].clone());
            }
        }

        if lod_points.is_empty() {
            continue;
        }

        // Get representative width (use first polyline's width or average)
        let avg_width = if !polylines.is_empty() {
            polylines[0].width
        } else {
            0.1
        };

        // Batch all polylines at this LOD into single vertex/index buffer
        let (verts, indices) = batch_polylines(&lod_points, avg_width);

        if verts.is_empty() || indices.is_empty() {
            continue;
        }

        let geometry_lod = GeometryLOD {
            vertex_data: encode_f32_array(&verts),
            vertex_count: verts.len() / 2,
            index_data: Some(encode_u32_array(&indices)),
            index_count: Some(indices.len()),
        };

        lod_geometries.push(geometry_lod);
    }

    let mut shader_geom = ShaderGeometry::default();
    shader_geom.batch = if lod_geometries.is_empty() {
        None
    } else {
        Some(lod_geometries)
    };

    Ok(LayerJSON {
        layer_id: layer_id.to_string(),
        layer_name: layer_name.to_string(),
        default_color: color,
        geometry: shader_geom,
    })
}

/// Extract all LayerFeatures from XML root and generate LayerJSON for each
pub fn extract_and_generate_layers(root: &XmlNode) -> Result<Vec<LayerJSON>, anyhow::Error> {
    let mut layer_jsons = Vec::new();
    let mut layers_seen = std::collections::HashSet::new();

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
    collect_layer_features(cad_data, &mut layer_jsons, &mut layers_seen)?;

    Ok(layer_jsons)
}

/// Recursively find LayerFeature nodes and generate LayerJSON for each unique layer
fn collect_layer_features(
    node: &XmlNode,
    layer_jsons: &mut Vec<LayerJSON>,
    layers_seen: &mut std::collections::HashSet<String>,
) -> Result<(), anyhow::Error> {
    // If this is a LayerFeature node, process it
    if node.name == "LayerFeature" {
        if let Some(layer_ref) = node.attributes.get("layerRef") {
            if !layers_seen.contains(layer_ref) {
                layers_seen.insert(layer_ref.clone());
                
                // Collect all polylines from this LayerFeature
                let mut polylines = Vec::new();
                collect_polylines_from_node(node, &mut polylines);
                
                if !polylines.is_empty() {
                    // Extract layer name from layerRef (e.g., "LAYER:Design" -> "Design")
                    let layer_name = layer_ref
                        .split(':')
                        .last()
                        .unwrap_or(layer_ref)
                        .to_string();
                    
                    // Generate default color based on layer type
                    let color = get_layer_color(layer_ref);
                    
                    let layer_json = generate_layer_json(
                        layer_ref,
                        &layer_name,
                        color,
                        &polylines,
                    )?;
                    
                    layer_jsons.push(layer_json);
                }
            }
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_layer_features(child, layer_jsons, layers_seen)?;
    }

    Ok(())
}

/// Get a color for a layer based on its name/type
fn get_layer_color(layer_ref: &str) -> [f32; 4] {
    let lower = layer_ref.to_lowercase();
    
    match true {
        _ if lower.contains("silkscreen") || lower.contains("silk") => [0.85, 0.7, 0.2, 1.0],
        _ if lower.contains("copper") || lower.contains(".cu") => [0.8, 0.6, 0.2, 1.0],
        _ if lower.contains("paste") => [0.5, 0.5, 0.5, 1.0],
        _ if lower.contains("mask") => [0.0, 0.5, 0.0, 1.0],
        _ if lower.contains("design") => [0.2, 0.7, 1.0, 1.0],
        _ => [0.7, 0.7, 0.7, 1.0], // default gray
    }
}

/// Recursively collect all Polyline elements from a specific node
fn collect_polylines_from_node(node: &XmlNode, polylines: &mut Vec<Polyline>) {
    // If this is a Polyline node, parse it
    if node.name == "Polyline" {
        if let Ok(polyline) = parse_polyline_node(node) {
            polylines.push(polyline);
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_polylines_from_node(child, polylines);
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
        let (verts, indices) = tessellate_polyline(&points, 0.1);
        
        assert!(verts.len() >= 8); // At least 4 vertices (2 per quad)
        assert!(indices.len() >= 6); // At least 6 indices (2 triangles)
    }

    #[test]
    fn test_base64_encode() {
        let data: Vec<f32> = vec![1.0, 2.0, 3.0];
        let encoded = encode_f32_array(&data);
        assert!(!encoded.is_empty());
        // Should be valid base64
        assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }
}

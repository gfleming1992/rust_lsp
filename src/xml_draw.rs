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
use std::env;

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
    let debug_this_layer = should_debug_layer(layer_id);
    let mut debug_header_printed = false;
    for lod_idx in 0..5 {
        let mut lod_polylines_data = Vec::new();
        
        for (poly_idx, polyline) in polylines.iter().enumerate() {
            if poly_idx < all_lod_points.len() && lod_idx < all_lod_points[poly_idx].len() {
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
        let (verts, indices) = batch_polylines_with_styles(&lod_polylines_data);

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

    if debug_this_layer && debug_header_printed {
        println!(
            "=== End of {} Tessellation (200 triangles shown) ===",
            layer_name
        );
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

    // Parse line descriptors from DictionaryLineDesc
    let line_descriptors = parse_line_descriptors(root);

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
    collect_layer_features(cad_data, &mut layer_jsons, &mut layers_seen, &line_descriptors)?;

    Ok(layer_jsons)
}

/// Recursively find LayerFeature nodes and generate LayerJSON for each unique layer
fn collect_layer_features(
    node: &XmlNode,
    layer_jsons: &mut Vec<LayerJSON>,
    layers_seen: &mut std::collections::HashSet<String>,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<(), anyhow::Error> {
    // If this is a LayerFeature node, process it
    if node.name == "LayerFeature" {
        if let Some(layer_ref) = node.attributes.get("layerRef") {
            if !layers_seen.contains(layer_ref) {
                layers_seen.insert(layer_ref.clone());
                
                // Collect all polylines from this LayerFeature
                let mut polylines = Vec::new();
                collect_polylines_from_node(node, &mut polylines, line_descriptors);
                
                if !polylines.is_empty() {
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
                        &polylines,
                    )?;
                    
                    layer_jsons.push(layer_json);
                }
            }
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_layer_features(child, layer_jsons, layers_seen, line_descriptors)?;
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

/// Recursively collect all Polyline elements from a specific node
fn collect_polylines_from_node(
    node: &XmlNode,
    polylines: &mut Vec<Polyline>,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) {
    // If this is a Polyline node, parse it
    if node.name == "Polyline" {
        if let Ok(polyline) = parse_polyline_node(node, line_descriptors) {
            polylines.push(polyline);
        }
    } else if node.name == "Line" {
        if let Ok(line_polyline) = parse_line_node(node, line_descriptors) {
            polylines.push(line_polyline);
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_polylines_from_node(child, polylines, line_descriptors);
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
    fn test_base64_encode() {
        let data: Vec<f32> = vec![1.0, 2.0, 3.0];
        let encoded = encode_f32_array(&data);
        assert!(!encoded.is_empty());
        // Should be valid base64
        assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
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

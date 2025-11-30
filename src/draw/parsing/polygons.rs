//! Polygon and contour parsing
//!
//! Handles parsing Polygon and Contour XML elements into geometry.

use crate::draw::geometry::*;
use crate::parse_xml::XmlNode;
use super::colors::parse_color;

/// Parse a Polygon node (filled shape with optional holes)
/// Expects <Polygon> with PolyBegin/PolyStepSegment children
pub fn parse_polygon_node(node: &XmlNode) -> Result<Polygon, anyhow::Error> {
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
        net_name: None, // Will be set by caller with net context
        component_ref: None, // Will be set by caller with component context
    })
}

/// Parse a Contour node (copper pour with cutouts)
/// Expects <Contour> with <Polygon> (outer boundary) and <Cutout> children (holes)
pub fn parse_contour_node(node: &XmlNode) -> Result<Polygon, anyhow::Error> {
    let mut outer_ring: Vec<Point> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    
    // Default fill color with alpha
    let fill_color = [0.5, 0.5, 0.5, 0.5];
    
    // Parse the outer Polygon
    if let Some(polygon_node) = node.children.iter().find(|c| c.name == "Polygon") {
        outer_ring = parse_poly_points(polygon_node);
    }
    
    // Parse all Cutout elements as holes
    for child in &node.children {
        if child.name == "Cutout" {
            let hole_ring = parse_poly_points(child);
            if hole_ring.len() >= 3 {
                holes.push(hole_ring);
            }
        }
    }
    
    if outer_ring.len() < 3 {
        return Err(anyhow::anyhow!("Contour must have a Polygon with at least 3 points"));
    }
    
    Ok(Polygon {
        outer_ring,
        holes,
        fill_color,
        net_name: None,
        component_ref: None,
    })
}

/// Helper to parse PolyBegin/PolyStepSegment points from a node
pub fn parse_poly_points(node: &XmlNode) -> Vec<Point> {
    let mut points = Vec::new();
    
    for child in &node.children {
        match child.name.as_str() {
            "PolyBegin" | "PolyStepSegment" | "PolyStepCurve" => {
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
    
    points
}

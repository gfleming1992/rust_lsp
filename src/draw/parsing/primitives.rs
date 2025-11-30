//! Standard primitive and padstack definition parsing
//!
//! Handles parsing DictionaryStandard entries and PadStackDef elements.

use crate::draw::geometry::*;
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use std::collections::HashMap;

/// Parse StandardPrimitive definitions from DictionaryStandard
pub fn parse_standard_primitives(root: &XmlNode) -> HashMap<String, StandardPrimitive> {
    let mut primitives = HashMap::new();
    
    // Helper to recursively visit all nodes
    fn visit_nodes(node: &XmlNode, primitives: &mut HashMap<String, StandardPrimitive>) {
        if node.name == "EntryStandard" {
            if let Some(id) = node.attributes.get("id") {
                for child in &node.children {
                    let mut shape = match child.name.as_str() {
                        "Circle" => {
                            let diameter = child.attributes.get("diameter")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Circle { diameter })
                        }
                        "RectCenter" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Rectangle { width, height })
                        }
                        "Oval" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Oval { width, height })
                        }
                        "RectRound" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let corner_radius = child.attributes.get("radius")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::RoundRect { width, height, corner_radius })
                        }
                        _ => None,
                    };
                    
                    // If no primitive found, check for <Contour><Polygon> (CUSTOM shapes)
                    if shape.is_none() {
                        if let Some(contour_node) = node.children.iter()
                            .find(|c| c.name == "Contour") {
                            if let Some(polygon_node) = contour_node.children.iter()
                                .find(|c| c.name == "Polygon") {
                                // Parse polygon points from PolyBegin + PolyStepSegment
                                let mut points = Vec::new();
                                for poly_child in &polygon_node.children {
                                    if poly_child.name == "PolyBegin" || poly_child.name == "PolyStepSegment" {
                                        if let (Some(x_str), Some(y_str)) = (poly_child.attributes.get("x"), poly_child.attributes.get("y")) {
                                            if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                                                points.push(Point { x, y });
                                            }
                                        }
                                    }
                                }
                                if !points.is_empty() {
                                    shape = Some(StandardPrimitive::CustomPolygon { points });
                                }
                            }
                        }
                    }
                    
                    if let Some(shape) = shape {
                        primitives.insert(id.clone(), shape);
                        break;
                    }
                }
            }
        }
        
        // Recursively visit children
        for child in &node.children {
            visit_nodes(child, primitives);
        }
    }
    
    visit_nodes(root, &mut primitives);
    primitives
}

/// Parse pad stack definitions and extract hole + outer diameter information
/// Returns a map of pad stack name -> definition (hole dia + outer dia)
pub fn parse_padstack_definitions(root: &XmlNode) -> IndexMap<String, PadStackDef> {
    let mut padstack_defs = IndexMap::new();
    
    // First, parse user primitive circles to get their diameters AND line widths
    // UserPrimitives can be HOLLOW circles (annular rings) with lineWidth defining ring thickness
    let mut user_circles: HashMap<String, (f32, f32)> = HashMap::new(); // id -> (diameter, lineWidth)
    
    // Helper to search for DictionaryUser
    fn find_dict_user(node: &XmlNode, circles: &mut HashMap<String, (f32, f32)>) {
        if node.name == "DictionaryUser" {
            for entry in &node.children {
                if entry.name == "EntryUser" {
                    if let Some(id) = entry.attributes.get("id") {
                        for user_special in &entry.children {
                            if user_special.name == "UserSpecial" {
                                for circle in &user_special.children {
                                    if circle.name == "Circle" {
                                        if let Some(dia) = circle.attributes.get("diameter") {
                                            if let Ok(diameter) = dia.parse::<f32>() {
                                                // Look for LineDesc child to get lineWidth (annular ring width)
                                                let mut line_width = 0.0;
                                                for desc in &circle.children {
                                                    if desc.name == "LineDesc" {
                                                        if let Some(lw) = desc.attributes.get("lineWidth") {
                                                            line_width = lw.parse().unwrap_or(0.0);
                                                        }
                                                    }
                                                }
                                                circles.insert(id.clone(), (diameter, line_width));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        for child in &node.children {
            find_dict_user(child, circles);
        }
    }
    
    find_dict_user(root, &mut user_circles);
    
    // Parse standard primitives for shape definitions
    let standard_primitives = parse_standard_primitives(root);
    
    // Now parse PadStackDef entries - search recursively for Step nodes containing PadStackDef
    fn find_padstack_defs(
        node: &XmlNode,
        defs: &mut IndexMap<String, PadStackDef>,
        circles: &HashMap<String, (f32, f32)>,  // id -> (diameter, lineWidth)
        primitives: &HashMap<String, StandardPrimitive>
    ) {
        if node.name == "Step" {
            for child in &node.children {
                if child.name == "PadStackDef" {
                    if let Some(name) = child.attributes.get("name") {
                        let mut hole_diameter = 0.0;
                        let mut outer_diameter = 0.0;
                        let mut shape: Option<StandardPrimitive> = None;
                        
                        // Find PadstackHoleDef
                        for hole_def in &child.children {
                            if hole_def.name == "PadstackHoleDef" {
                                hole_diameter = hole_def
                                    .attributes
                                    .get("diameter")
                                    .and_then(|d| d.parse::<f32>().ok())
                                    .unwrap_or(0.0);
                            }
                            
                            // Find PadstackPadDef to get shape
                            if hole_def.name == "PadstackPadDef" {
                                for pad_child in &hole_def.children {
                                    // Check for UserPrimitiveRef (circles with optional lineWidth for annular rings)
                                    if pad_child.name == "UserPrimitiveRef" {
                                        if let Some(user_id) = pad_child.attributes.get("id") {
                                            if let Some(&(center_dia, line_width)) = circles.get(user_id) {
                                                // If lineWidth > 0, this is a HOLLOW circle (annular ring)
                                                // The diameter is the centerline, lineWidth is the ring thickness
                                                // Outer diameter = center_dia + line_width
                                                // Inner diameter would be center_dia - line_width, but we use hole_diameter instead
                                                if line_width > 0.0 {
                                                    // Annular ring: outer edge is centerline + half lineWidth on each side
                                                    outer_diameter = center_dia + line_width;
                                                } else {
                                                    // Solid circle
                                                    outer_diameter = center_dia;
                                                }
                                                shape = Some(StandardPrimitive::Circle { diameter: outer_diameter });
                                            }
                                        }
                                    }
                                    // Check for StandardPrimitiveRef (all shapes)
                                    else if pad_child.name == "StandardPrimitiveRef" {
                                        if let Some(std_id) = pad_child.attributes.get("id") {
                                            if let Some(prim) = primitives.get(std_id) {
                                                shape = Some(prim.clone());
                                                // Set outer_diameter based on shape type
                                                outer_diameter = match prim {
                                                    StandardPrimitive::Circle { diameter } => *diameter,
                                                    StandardPrimitive::Rectangle { width, height } => width.max(*height),
                                                    StandardPrimitive::Oval { width, height } => width.max(*height),
                                                    StandardPrimitive::RoundRect { width, height, .. } => width.max(*height),
                                                    StandardPrimitive::CustomPolygon { points } => {
                                                        // Find bounding box of polygon
                                                        let mut max_dim = 0.0f32;
                                                        for p in points {
                                                            max_dim = max_dim.max(p.x.abs()).max(p.y.abs());
                                                        }
                                                        max_dim * 2.0
                                                    }
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        if hole_diameter > 0.0 && outer_diameter > 0.0 {
                            if let Some(shape) = shape {
                                defs.insert(
                                    name.clone(),
                                    PadStackDef {
                                        hole_diameter,
                                        outer_diameter,
                                        shape,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
        
        // Recurse into children
        for child in &node.children {
            find_padstack_defs(child, defs, circles, primitives);
        }
    }
    
    find_padstack_defs(root, &mut padstack_defs, &user_circles, &standard_primitives);
    
    padstack_defs
}

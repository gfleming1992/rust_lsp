//! Pad and via collection from layers
//!
//! Handles collecting PadInstance and ViaInstance from LayerFeature nodes.

use crate::draw::geometry::*;
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use std::collections::HashMap;

/// Collect pad instances from LayerFeature nodes
pub fn collect_pads_from_layer(layer_node: &XmlNode, padstack_defs: &IndexMap<String, PadStackDef>) -> Vec<PadInstance> {
    let mut pads = Vec::new();
    
    // Helper to recursively visit all nodes, tracking net and component context from Set nodes
    fn visit_nodes(node: &XmlNode, pads: &mut Vec<PadInstance>, padstack_defs: &IndexMap<String, PadStackDef>, current_net: Option<&str>, current_component: Option<&str>) {
        // Check if this is a Set with a net attribute or componentRef
        let net_context = if node.name == "Set" {
            node.attributes.get("net").map(|s| s.as_str()).or(current_net)
        } else {
            current_net
        };
        
        let component_context = if node.name == "Set" {
            node.attributes.get("componentRef").map(|s| s.as_str()).or(current_component)
        } else {
            current_component
        };
        
        if node.name == "Pad" {
            // Skip if this is a via (padUsage="VIA")
            if let Some(usage) = node.attributes.get("padUsage") {
                if usage == "VIA" {
                    return; // Don't collect as pad
                }
            }
            
            // Skip if this has a padstackDefRef with an actual hole (PTH - will be rendered as via)
            if let Some(ref_name) = node.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(ref_name) {
                    // Only skip if there's a significant hole (> 0.01mm)
                    if def.hole_diameter > 0.01 {
                        return; // Don't collect as pad, it's a PTH
                    }
                }
            }
            
            let mut x = 0.0;
            let mut y = 0.0;
            let mut rotation = 0.0;
            let mut shape_id = String::new();
            let mut component_ref = component_context.map(|s| s.to_string());
            let mut pin_ref: Option<String> = None;
            
            for child in &node.children {
                match child.name.as_str() {
                    "Location" => {
                        x = child.attributes.get("x")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                        y = child.attributes.get("y")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                    }
                    "Xform" => {
                        rotation = child.attributes.get("rotation")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                    }
                    "StandardPrimitiveRef" => {
                        shape_id = child.attributes.get("id")
                            .cloned()
                            .unwrap_or_default();
                    }
                    "PinRef" => {
                        // Get componentRef and pin from PinRef child element
                        if let Some(comp_ref) = child.attributes.get("componentRef") {
                            component_ref = Some(comp_ref.clone());
                        }
                        if let Some(pin) = child.attributes.get("pin") {
                            pin_ref = Some(pin.clone());
                        }
                    }
                    _ => {}
                }
            }
            
            if !shape_id.is_empty() {
                pads.push(PadInstance {
                    shape_id,
                    x,
                    y,
                    rotation,
                    net_name: net_context.map(|s| s.to_string()),
                    component_ref,
                    pin_ref,
                });
            }
        }
        
        // Recursively visit children with net and component context
        for child in &node.children {
            visit_nodes(child, pads, padstack_defs, net_context, component_context);
        }
    }
    
    visit_nodes(layer_node, &mut pads, padstack_defs, None, None);
    pads
}

/// Collect via instances from LayerFeature nodes
/// Also collects plated through holes (PTH) which have actual holes
pub fn collect_vias_from_layer(layer_node: &XmlNode, padstack_defs: &IndexMap<String, PadStackDef>) -> Vec<ViaInstance> {
    let mut vias = Vec::new();
    
    // Helper to recursively visit all nodes, tracking net and component context from Set nodes
    // Collect both explicit vias (in Set padUsage="VIA") and PTH pads (pads with holes)
    // Both types span multiple layers and should be treated the same for deletion
    fn visit_nodes(node: &XmlNode, vias: &mut Vec<ViaInstance>, padstack_defs: &IndexMap<String, PadStackDef>, parent_is_via_set: bool, current_net: Option<&str>, current_component: Option<&str>) {
        // Check if this is a Set with padUsage="VIA"
        let is_via_set = node.name == "Set" && node.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
        
        // Check if this Set has a net attribute or componentRef
        let net_context = if node.name == "Set" {
            node.attributes.get("net").map(|s| s.as_str()).or(current_net)
        } else {
            current_net
        };
        
        let component_context = if node.name == "Set" {
            node.attributes.get("componentRef").map(|s| s.as_str()).or(current_component)
        } else {
            current_component
        };
        
        if node.name == "Pad" {
            // Collect pads that are either:
            // 1. Inside a Set with padUsage="VIA" (explicit vias)
            // 2. Have a padstack with a hole > 0.01mm (PTH pads - also span multiple layers)
            let in_via_set = parent_is_via_set || is_via_set;
            
            if let Some(ref_name) = node.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(ref_name) {
                    // Collect if in via set OR has a significant hole (PTH pad)
                    if in_via_set || def.hole_diameter > 0.01 {
                        let mut x = 0.0;
                        let mut y = 0.0;
                        let mut component_ref = component_context.map(|s| s.to_string());
                        let mut pin_ref: Option<String> = None;
                        
                        for child in &node.children {
                            match child.name.as_str() {
                                "Location" => {
                                    x = child.attributes.get("x")
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(0.0);
                                    y = child.attributes.get("y")
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(0.0);
                                }
                                "PinRef" => {
                                    // Get componentRef and pin from PinRef child element
                                    if let Some(comp_ref) = child.attributes.get("componentRef") {
                                        component_ref = Some(comp_ref.clone());
                                    }
                                    if let Some(pin) = child.attributes.get("pin") {
                                        pin_ref = Some(pin.clone());
                                    }
                                }
                                _ => {}
                            }
                        }
                        
                        vias.push(ViaInstance {
                            x,
                            y,
                            diameter: def.outer_diameter,
                            hole_diameter: def.hole_diameter,
                            shape: def.shape.clone(),
                            net_name: net_context.map(|s| s.to_string()),
                            component_ref,
                            pin_ref,
                        });
                    }
                }
            }
        }
        
        // Recursively visit children, passing down via_set status and net/component context
        for child in &node.children {
            visit_nodes(child, vias, padstack_defs, is_via_set || parent_is_via_set, net_context, component_context);
        }
    }
    
    visit_nodes(layer_node, &mut vias, padstack_defs, false, None, None);
    vias
}

/// Recursively find Step nodes and collect PadStack instances defined at the Step level
/// PadStacks with holes become vias, PadStacks without holes become pads
pub fn collect_padstacks_from_step(
    node: &XmlNode,
    layer_contexts: &mut IndexMap<String, LayerGeometries>,
    primitives: &HashMap<String, StandardPrimitive>,
) {
    if node.name == "Step" {
        // Look for PadStack nodes directly under Step
        for child in &node.children {
            if child.name == "PadStack" {
                // Parse inline PadStack definition
                
                // Get net name from PadStack's net attribute
                let net_name = child.attributes.get("net").map(|s| s.to_string());
                
                // 1. Parse LayerHole (optional - only present for vias/PTH)
                let mut hole_diameter = 0.0;
                
                for subchild in &child.children {
                    if subchild.name == "LayerHole" {
                        if let Some(diam_str) = subchild.attributes.get("diameter") {
                            if let Ok(d) = diam_str.parse::<f32>() {
                                hole_diameter = d;
                            }
                        }
                    }
                }
                
                // Determine if this is a via (has hole) or SMD pad (no hole)
                let is_via = hole_diameter > 0.01;
                
                // 2. Parse LayerPad elements
                for subchild in &child.children {
                    if subchild.name == "LayerPad" {
                        if let Some(layer_ref) = subchild.attributes.get("layerRef") {
                            // Parse location
                            let mut x = 0.0;
                            let mut y = 0.0;
                            let mut rotation = 0.0;
                            
                            // Find Location node
                            if let Some(loc_node) = subchild.children.iter().find(|n| n.name == "Location") {
                                x = loc_node.attributes.get("x").and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
                                y = loc_node.attributes.get("y").and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
                            }
                            
                            // Find Xform for rotation
                            if let Some(xform_node) = subchild.children.iter().find(|n| n.name == "Xform") {
                                rotation = xform_node.attributes.get("rotation").and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
                            }
                            
                            // Find StandardPrimitiveRef
                            if let Some(prim_ref) = subchild.children.iter().find(|n| n.name == "StandardPrimitiveRef") {
                                if let Some(prim_id) = prim_ref.attributes.get("id") {
                                    // Get component_ref and pin_ref from PinRef if present
                                    let mut component_ref: Option<String> = None;
                                    let mut pin_ref: Option<String> = None;
                                    if let Some(pin_ref_node) = subchild.children.iter().find(|n| n.name == "PinRef") {
                                        component_ref = pin_ref_node.attributes.get("componentRef").cloned();
                                        pin_ref = pin_ref_node.attributes.get("pin").cloned();
                                    }
                                    
                                    let layer_geom = layer_contexts.entry(layer_ref.clone())
                                        .or_insert_with(|| LayerGeometries {
                                            layer_ref: layer_ref.clone(),
                                            polylines: Vec::new(),
                                            polygons: Vec::new(),
                                            padstack_holes: Vec::new(),
                                            pads: Vec::new(),
                                            vias: Vec::new(),
                                        });
                                    
                                    if is_via {
                                        // Has hole - treat as via
                                        if let Some(primitive) = primitives.get(prim_id) {
                                            let outer_diameter = match primitive {
                                                StandardPrimitive::Circle { diameter } => *diameter,
                                                StandardPrimitive::Rectangle { width, height } => width.max(*height),
                                                StandardPrimitive::Oval { width, height } => width.max(*height),
                                                StandardPrimitive::RoundRect { width, height, .. } => width.max(*height),
                                                StandardPrimitive::CustomPolygon { .. } => 0.0,
                                            };
                                            
                                            layer_geom.vias.push(ViaInstance {
                                                x,
                                                y,
                                                diameter: outer_diameter,
                                                hole_diameter,
                                                shape: primitive.clone(),
                                                net_name: net_name.clone(),
                                                component_ref,
                                                pin_ref,
                                            });
                                        }
                                    } else {
                                        // No hole - treat as SMD pad
                                        layer_geom.pads.push(PadInstance {
                                            shape_id: prim_id.clone(),
                                            x,
                                            y,
                                            rotation,
                                            net_name: net_name.clone(),
                                            component_ref,
                                            pin_ref,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Recurse
    for child in &node.children {
        collect_padstacks_from_step(child, layer_contexts, primitives);
    }
}

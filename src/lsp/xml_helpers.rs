//! XML manipulation helpers for the LSP server

use crate::draw::geometry::{LayerJSON, ObjectRange, PadStackDef};
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use std::collections::HashMap;

/// Parse DictionaryColor from XML root to extract layer colors
pub fn parse_dictionary_colors(root: &XmlNode) -> HashMap<String, [f32; 4]> {
    let mut colors = HashMap::new();
    
    if let Some(content) = root.children.iter().find(|n| n.name == "Content") {
        if let Some(dict_color) = content.children.iter().find(|n| n.name == "DictionaryColor") {
            for entry in &dict_color.children {
                if entry.name == "EntryColor" {
                    if let Some(id) = entry.attributes.get("id") {
                        if let Some(color_node) = entry.children.iter().find(|n| n.name == "Color") {
                            let r = color_node.attributes.get("r")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            let g = color_node.attributes.get("g")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            let b = color_node.attributes.get("b")
                                .and_then(|v| v.parse::<u8>().ok())
                                .unwrap_or(255) as f32 / 255.0;
                            
                            colors.insert(id.clone(), [r, g, b, 1.0]);
                        }
                    }
                }
            }
        }
    }
    
    colors
}

/// Update DictionaryColor in XML tree with only the modified layer colors
pub fn update_dictionary_colors(root: &mut XmlNode, modified_colors: &HashMap<String, [f32; 4]>) {
    let content = match root.children.iter_mut().find(|n| n.name == "Content") {
        Some(c) => c,
        None => return,
    };
    
    let dict_color = match content.children.iter_mut().find(|n| n.name == "DictionaryColor") {
        Some(d) => d,
        None => {
            let mut new_dict = XmlNode {
                name: "DictionaryColor".to_string(),
                attributes: indexmap::IndexMap::new(),
                children: Vec::new(),
                text_content: String::new(),
            };
            
            for (layer_id, color) in modified_colors {
                new_dict.children.push(create_entry_color(layer_id, color));
            }
            
            content.children.insert(0, new_dict);
            return;
        }
    };
    
    for (layer_id, color) in modified_colors {
        let existing = dict_color.children.iter_mut().find(|entry| {
            entry.name == "EntryColor" && 
            entry.attributes.get("id").map(|s| s.as_str()) == Some(layer_id.as_str())
        });
        
        if let Some(entry) = existing {
            if let Some(color_node) = entry.children.iter_mut().find(|n| n.name == "Color") {
                let r = (color[0] * 255.0).round() as u8;
                let g = (color[1] * 255.0).round() as u8;
                let b = (color[2] * 255.0).round() as u8;
                color_node.attributes.insert("r".to_string(), r.to_string());
                color_node.attributes.insert("g".to_string(), g.to_string());
                color_node.attributes.insert("b".to_string(), b.to_string());
            }
        } else {
            dict_color.children.push(create_entry_color(layer_id, color));
        }
    }
}

/// Helper to create an EntryColor node
fn create_entry_color(layer_id: &str, color: &[f32; 4]) -> XmlNode {
    let mut entry_attrs = indexmap::IndexMap::new();
    entry_attrs.insert("id".to_string(), layer_id.to_string());
    
    let r = (color[0] * 255.0).round() as u8;
    let g = (color[1] * 255.0).round() as u8;
    let b = (color[2] * 255.0).round() as u8;
    
    let mut color_attrs = indexmap::IndexMap::new();
    color_attrs.insert("r".to_string(), r.to_string());
    color_attrs.insert("g".to_string(), g.to_string());
    color_attrs.insert("b".to_string(), b.to_string());
    
    XmlNode {
        name: "EntryColor".to_string(),
        attributes: entry_attrs,
        children: vec![XmlNode {
            name: "Color".to_string(),
            attributes: color_attrs,
            children: Vec::new(),
            text_content: String::new(),
        }],
        text_content: String::new(),
    }
}

/// Remove deleted objects from XML tree
/// Returns the number of objects removed
pub fn remove_deleted_objects_from_xml(
    root: &mut XmlNode,
    deleted_objects: &HashMap<u64, ObjectRange>,
    _layers: &[LayerJSON],
    padstack_defs: &IndexMap<String, PadStackDef>,
) -> usize {
    // Build a map of layer_id -> set of deleted object indices by type
    let mut deleted_by_layer: HashMap<String, HashMap<u8, std::collections::HashSet<usize>>> = HashMap::new();
    
    for (id, range) in deleted_objects {
        let obj_index = (*id & 0xFFFFFFFFF) as usize;
        let obj_type = range.obj_type;
        
        eprintln!("[XML Remove] Marking for deletion: layer={}, obj_type={}, index={}", 
            range.layer_id, obj_type, obj_index);
        
        deleted_by_layer
            .entry(range.layer_id.clone())
            .or_default()
            .entry(obj_type)
            .or_default()
            .insert(obj_index);
    }
    
    let mut total_removed = 0;
    let mut counters: HashMap<String, HashMap<u8, usize>> = HashMap::new();
    
    process_node(root, &deleted_by_layer, None, false, &mut counters, &mut total_removed, padstack_defs);
    
    eprintln!("[XML Remove] Total removed: {}", total_removed);
    total_removed
}

fn process_node(
    node: &mut XmlNode,
    deleted_by_layer: &HashMap<String, HashMap<u8, std::collections::HashSet<usize>>>,
    current_layer: Option<&str>,
    in_via_set: bool,
    counters: &mut HashMap<String, HashMap<u8, usize>>,
    removed: &mut usize,
    padstack_defs: &IndexMap<String, PadStackDef>,
) {
    let layer_ref = if node.name == "LayerFeature" {
        node.attributes.get("layerRef").map(|s| s.as_str())
    } else {
        current_layer
    };
    
    let is_via_set = node.name == "Set" && 
        node.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
    let child_in_via_set = in_via_set || is_via_set;
    
    let mut i = 0;
    while i < node.children.len() {
        let should_remove = check_should_remove(
            &node.children[i], 
            layer_ref, 
            child_in_via_set, 
            counters, 
            deleted_by_layer,
            padstack_defs
        );
        
        match should_remove {
            Some(true) => {
                node.children.remove(i);
                *removed += 1;
            }
            _ => {
                let child_mut = &mut node.children[i];
                process_node(child_mut, deleted_by_layer, layer_ref, child_in_via_set, 
                    counters, removed, padstack_defs);
                i += 1;
            }
        }
    }
}

fn check_should_remove(
    child: &XmlNode, 
    layer: Option<&str>, 
    parent_in_via_set: bool, 
    counters: &mut HashMap<String, HashMap<u8, usize>>,
    deleted_by_layer: &HashMap<String, HashMap<u8, std::collections::HashSet<usize>>>,
    padstack_defs: &IndexMap<String, PadStackDef>
) -> Option<bool> {
    let layer_id = layer?;
    
    let obj_type = match child.name.as_str() {
        "Polyline" | "Line" => Some(0u8),
        "Polygon" => Some(1u8),
        "Pad" => {
            let has_via_attr = child.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
            let in_via_set = parent_in_via_set;
            
            let is_pth = if let Some(padstack_ref) = child.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(padstack_ref) {
                    def.hole_diameter > 0.01
                } else {
                    false
                }
            } else {
                false
            };
            
            if has_via_attr || in_via_set || is_pth {
                Some(2u8) // Via / PTH pad
            } else {
                Some(3u8) // SMD Pad
            }
        }
        _ => None,
    }?;
    
    let count = counters
        .entry(layer_id.to_string())
        .or_default()
        .entry(obj_type)
        .or_insert(0);
    
    let current_idx = *count;
    *count += 1;
    
    if let Some(deleted_for_layer) = deleted_by_layer.get(layer_id) {
        if let Some(deleted_indices) = deleted_for_layer.get(&obj_type) {
            if deleted_indices.contains(&current_idx) {
                eprintln!("[XML Remove] Removing {} at index {} from layer {}", 
                    child.name, current_idx, layer_id);
                return Some(true);
            }
        }
    }
    
    Some(false)
}

/// Apply move deltas to objects in XML tree
/// Returns the number of objects modified
pub fn apply_moved_objects_to_xml(
    root: &mut XmlNode,
    moved_objects: &HashMap<u64, crate::lsp::state::ObjectMove>,
    all_object_ranges: &[ObjectRange],
    padstack_defs: &IndexMap<String, PadStackDef>,
) -> usize {
    if moved_objects.is_empty() {
        return 0;
    }
    
    // Build lookup: object_id -> (delta_x, delta_y, layer_id, obj_type)
    let mut move_lookup: HashMap<(String, u8, usize), (f32, f32)> = HashMap::new();
    
    for (obj_id, mov) in moved_objects {
        // Find the object range to get layer_id and obj_type
        if let Some(range) = all_object_ranges.iter().find(|r| r.id == *obj_id) {
            let obj_index = (*obj_id & 0xFFFFFFFFF) as usize;
            let key = (range.layer_id.clone(), range.obj_type, obj_index);
            move_lookup.insert(key, (mov.delta_x, mov.delta_y));
            eprintln!("[XML Move] Marking for move: layer={}, obj_type={}, index={}, delta=({:.3}, {:.3})", 
                range.layer_id, range.obj_type, obj_index, mov.delta_x, mov.delta_y);
        }
    }
    
    let mut total_modified = 0;
    let mut counters: HashMap<String, HashMap<u8, usize>> = HashMap::new();
    
    apply_moves_to_node(root, &move_lookup, None, false, &mut counters, &mut total_modified, padstack_defs);
    
    eprintln!("[XML Move] Total modified: {}", total_modified);
    total_modified
}

fn apply_moves_to_node(
    node: &mut XmlNode,
    move_lookup: &HashMap<(String, u8, usize), (f32, f32)>,
    current_layer: Option<&str>,
    in_via_set: bool,
    counters: &mut HashMap<String, HashMap<u8, usize>>,
    modified: &mut usize,
    padstack_defs: &IndexMap<String, PadStackDef>,
) {
    let layer_ref = if node.name == "LayerFeature" {
        node.attributes.get("layerRef").map(|s| s.as_str())
    } else {
        current_layer
    };
    
    let is_via_set = node.name == "Set" && 
        node.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
    let child_in_via_set = in_via_set || is_via_set;
    
    for child in &mut node.children {
        // Check if this child should be moved
        if let Some((delta_x, delta_y)) = check_should_move(
            child, 
            layer_ref, 
            child_in_via_set, 
            counters, 
            move_lookup,
            padstack_defs
        ) {
            apply_move_to_node(child, delta_x, delta_y);
            *modified += 1;
        }
        
        // Recurse into children
        apply_moves_to_node(child, move_lookup, layer_ref, child_in_via_set, 
            counters, modified, padstack_defs);
    }
}

fn check_should_move(
    child: &XmlNode, 
    layer: Option<&str>, 
    parent_in_via_set: bool, 
    counters: &mut HashMap<String, HashMap<u8, usize>>,
    move_lookup: &HashMap<(String, u8, usize), (f32, f32)>,
    padstack_defs: &IndexMap<String, PadStackDef>
) -> Option<(f32, f32)> {
    let layer_id = layer?;
    
    let obj_type = match child.name.as_str() {
        "Polyline" | "Line" => Some(0u8),
        "Polygon" => Some(1u8),
        "Pad" => {
            let has_via_attr = child.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
            let in_via_set = parent_in_via_set;
            
            let is_pth = if let Some(padstack_ref) = child.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(padstack_ref) {
                    def.hole_diameter > 0.01
                } else {
                    false
                }
            } else {
                false
            };
            
            if has_via_attr || in_via_set || is_pth {
                Some(2u8) // Via / PTH pad
            } else {
                Some(3u8) // SMD Pad
            }
        }
        _ => None,
    }?;
    
    let count = counters
        .entry(layer_id.to_string())
        .or_default()
        .entry(obj_type)
        .or_insert(0);
    
    let current_idx = *count;
    *count += 1;
    
    let key = (layer_id.to_string(), obj_type, current_idx);
    move_lookup.get(&key).copied()
}

/// Apply a move delta to a geometry node (Pad, Polyline, Polygon, etc.)
fn apply_move_to_node(node: &mut XmlNode, delta_x: f32, delta_y: f32) {
    match node.name.as_str() {
        "Pad" => {
            // Pads have a Location child element with x, y attributes
            for child in &mut node.children {
                if child.name == "Location" {
                    if let Some(x_str) = child.attributes.get("x") {
                        if let Ok(x) = x_str.parse::<f32>() {
                            child.attributes.insert("x".to_string(), format!("{:.6}", x + delta_x));
                        }
                    }
                    if let Some(y_str) = child.attributes.get("y") {
                        if let Ok(y) = y_str.parse::<f32>() {
                            child.attributes.insert("y".to_string(), format!("{:.6}", y + delta_y));
                        }
                    }
                }
            }
            eprintln!("[XML Move] Applied delta to Pad: ({:.3}, {:.3})", delta_x, delta_y);
        }
        "Polyline" => {
            // Polylines have child PolyBegin and PolyStepSegment/PolyStepCurve nodes
            for child in &mut node.children {
                apply_move_to_coordinate_node(child, delta_x, delta_y);
            }
            eprintln!("[XML Move] Applied delta to Polyline");
        }
        "Line" => {
            // Line elements have startX, startY, endX, endY attributes directly
            for attr in ["startX", "endX"] {
                if let Some(val_str) = node.attributes.get(attr) {
                    if let Ok(val) = val_str.parse::<f32>() {
                        node.attributes.insert(attr.to_string(), format!("{:.6}", val + delta_x));
                    }
                }
            }
            for attr in ["startY", "endY"] {
                if let Some(val_str) = node.attributes.get(attr) {
                    if let Ok(val) = val_str.parse::<f32>() {
                        node.attributes.insert(attr.to_string(), format!("{:.6}", val + delta_y));
                    }
                }
            }
            eprintln!("[XML Move] Applied delta to Line");
        }
        "Polygon" => {
            // Polygon elements directly contain PolyBegin/PolyStepSegment
            for child in &mut node.children {
                apply_move_to_coordinate_node(child, delta_x, delta_y);
            }
            eprintln!("[XML Move] Applied delta to Polygon");
        }
        "Contour" => {
            // Contour elements have Polygon (outer boundary) and Cutout children
            for child in &mut node.children {
                if child.name == "Polygon" || child.name == "Cutout" {
                    for contour_child in &mut child.children {
                        apply_move_to_coordinate_node(contour_child, delta_x, delta_y);
                    }
                }
            }
            eprintln!("[XML Move] Applied delta to Contour");
        }
        _ => {}
    }
}

/// Apply move to a coordinate node (PolyBegin, PolyStepSegment, PolyStepCurve, etc.)
fn apply_move_to_coordinate_node(node: &mut XmlNode, delta_x: f32, delta_y: f32) {
    match node.name.as_str() {
        "PolyBegin" | "PolyStepSegment" | "Segment" => {
            if let Some(x_str) = node.attributes.get("x") {
                if let Ok(x) = x_str.parse::<f32>() {
                    node.attributes.insert("x".to_string(), format!("{:.6}", x + delta_x));
                }
            }
            if let Some(y_str) = node.attributes.get("y") {
                if let Ok(y) = y_str.parse::<f32>() {
                    node.attributes.insert("y".to_string(), format!("{:.6}", y + delta_y));
                }
            }
        }
        "PolyStepCurve" => {
            // Curves have x, y and cx, cy (control point)
            for attr in ["x", "cx"] {
                if let Some(val_str) = node.attributes.get(attr) {
                    if let Ok(val) = val_str.parse::<f32>() {
                        node.attributes.insert(attr.to_string(), format!("{:.6}", val + delta_x));
                    }
                }
            }
            for attr in ["y", "cy"] {
                if let Some(val_str) = node.attributes.get(attr) {
                    if let Ok(val) = val_str.parse::<f32>() {
                        node.attributes.insert(attr.to_string(), format!("{:.6}", val + delta_y));
                    }
                }
            }
        }
        _ => {}
    }
}


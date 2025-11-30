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

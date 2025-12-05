//! Line descriptor and layer function parsing
//!
//! Handles parsing DictionaryLineDesc entries and layer function attributes.

use crate::draw::geometry::*;
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use std::collections::HashMap;

/// Parse line end from string
pub fn parse_line_end(line_end_str: &str) -> LineEnd {
    match line_end_str.to_uppercase().as_str() {
        "ROUND" => LineEnd::Round,
        "SQUARE" => LineEnd::Square,
        "BUTT" => LineEnd::Butt,
        _ => LineEnd::Round, // Default to round
    }
}

/// Parse DictionaryLineDesc to extract line width and end style for each line ID
pub fn parse_line_descriptors(root: &XmlNode) -> IndexMap<String, LineDescriptor> {
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

/// Layer metadata including function and side
#[derive(Clone, Debug)]
pub struct LayerMeta {
    pub function: String,  // CONDUCTOR, SOLDERMASK, SILKSCREEN, etc.
    pub side: String,      // TOP, BOTTOM, INTERNAL, NONE, ALL
}

/// Parse layer function and side attributes from Layer elements in the StackupGroup
/// Returns a map from layer name to LayerMeta
pub fn parse_layer_metadata(root: &XmlNode) -> HashMap<String, LayerMeta> {
    let mut layer_meta = HashMap::new();
    
    // Recursive helper to find all Layer elements
    fn find_layers(node: &XmlNode, meta: &mut HashMap<String, LayerMeta>) {
        if node.name == "Layer" {
            if let Some(name) = node.attributes.get("name") {
                let function = node.attributes.get("layerFunction")
                    .cloned()
                    .unwrap_or_default();
                let side = node.attributes.get("side")
                    .cloned()
                    .unwrap_or_else(|| "NONE".to_string());
                
                let layer_meta_entry = LayerMeta { 
                    function: function.clone(), 
                    side: side.clone() 
                };
                
                meta.insert(name.clone(), layer_meta_entry.clone());
                // Also store with the full layer ref format
                if !name.starts_with("LAYER:") && !name.starts_with("LAYER_") {
                    meta.insert(format!("LAYER:{}", name), layer_meta_entry);
                }
            }
        }
        
        for child in &node.children {
            find_layers(child, meta);
        }
    }
    
    find_layers(root, &mut layer_meta);
    layer_meta
}

/// Parse layer function attribute from Layer elements in the StackupGroup
/// Returns a map from layer name to function (SIGNAL, CONDUCTOR, PLANE, MIXED, etc.)
/// (Legacy function - use parse_layer_metadata for full info)
pub fn parse_layer_functions(root: &XmlNode) -> HashMap<String, String> {
    parse_layer_metadata(root)
        .into_iter()
        .map(|(k, v)| (k, v.function))
        .collect()
}

/// Build layer pairs mapping TOP layers to their BOTTOM counterparts
/// Matches by layerFunction (e.g., F.Cu CONDUCTOR/TOP ↔ B.Cu CONDUCTOR/BOTTOM)
pub fn build_layer_pairs(layer_meta: &HashMap<String, LayerMeta>) -> HashMap<String, String> {
    let mut pairs = HashMap::new();
    
    // Group layers by function
    let mut by_function: HashMap<&str, Vec<(&String, &LayerMeta)>> = HashMap::new();
    for (name, meta) in layer_meta {
        by_function.entry(&meta.function)
            .or_default()
            .push((name, meta));
    }
    
    // For each function, pair TOP with BOTTOM
    for (_function, layers) in by_function {
        let top_layers: Vec<_> = layers.iter()
            .filter(|(_, m)| m.side == "TOP")
            .collect();
        let bottom_layers: Vec<_> = layers.iter()
            .filter(|(_, m)| m.side == "BOTTOM")
            .collect();
        
        // If exactly one of each, pair them
        if top_layers.len() == 1 && bottom_layers.len() == 1 {
            let top_name = top_layers[0].0;
            let bottom_name = bottom_layers[0].0;
            pairs.insert(top_name.clone(), bottom_name.clone());
            pairs.insert(bottom_name.clone(), top_name.clone());
        }
        // If multiple, try to match by name pattern (F. ↔ B., Top ↔ Bottom)
        else if !top_layers.is_empty() && !bottom_layers.is_empty() {
            for (top_name, _) in &top_layers {
                // Try common naming patterns
                let potential_bottom = top_name
                    .replace("F.", "B.")
                    .replace("Top", "Bottom")
                    .replace("TOP", "BOTTOM")
                    .replace("_T_", "_B_")
                    .replace(".T.", ".B.");
                
                if let Some((bottom_name, _)) = bottom_layers.iter()
                    .find(|(n, _)| **n == potential_bottom) 
                {
                    pairs.insert((*top_name).clone(), (*bottom_name).clone());
                    pairs.insert((*bottom_name).clone(), (*top_name).clone());
                }
            }
        }
    }
    
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_line_end() {
        assert_eq!(parse_line_end("ROUND"), LineEnd::Round);
        assert_eq!(parse_line_end("round"), LineEnd::Round);
        assert_eq!(parse_line_end("SQUARE"), LineEnd::Square);
        assert_eq!(parse_line_end("BUTT"), LineEnd::Butt);
        assert_eq!(parse_line_end("unknown"), LineEnd::Round); // Default
    }
}

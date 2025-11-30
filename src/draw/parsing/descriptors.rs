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

/// Parse layer function attribute from Layer elements in the StackupGroup
/// Returns a map from layer name to function (SIGNAL, CONDUCTOR, PLANE, MIXED, etc.)
pub fn parse_layer_functions(root: &XmlNode) -> HashMap<String, String> {
    let mut layer_functions = HashMap::new();
    
    // Recursive helper to find all Layer elements
    fn find_layers(node: &XmlNode, functions: &mut HashMap<String, String>) {
        if node.name == "Layer" {
            if let Some(name) = node.attributes.get("name") {
                if let Some(function) = node.attributes.get("layerFunction") {
                    functions.insert(name.clone(), function.clone());
                    // Also store with the full layer ref format
                    if !name.starts_with("LAYER:") && !name.starts_with("LAYER_") {
                        functions.insert(format!("LAYER:{}", name), function.clone());
                    }
                }
            }
        }
        
        for child in &node.children {
            find_layers(child, functions);
        }
    }
    
    find_layers(root, &mut layer_functions);
    layer_functions
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

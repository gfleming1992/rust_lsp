/// XML serialization module - writes XmlNode structures back to XML files
/// 
/// This module provides fast serialization of parsed XML trees back to file format,
/// useful for validating parse fidelity, roundtrip testing, and performance benchmarking.

use crate::parse_xml::XmlNode;
use anyhow::{Result, Context};
use std::fs;
use std::path::Path;

/// Serializes an XmlNode and all its descendants to an XML string
/// 
/// # Arguments
/// * `node` - The root node to serialize
/// * `indent_level` - Starting indentation level (typically 0)
/// 
/// # Returns
/// A formatted XML string representation of the node tree
pub fn xml_node_to_string(node: &XmlNode, indent_level: usize) -> String {
    let mut output = String::new();
    serialize_node(node, indent_level, &mut output);
    output
}

/// Serializes an XmlNode tree to a file on disk
/// 
/// # Arguments
/// * `node` - The root node to serialize
/// * `file_path` - Path where XML file will be written
/// 
/// # Returns
/// Result indicating success or error
pub fn xml_node_to_file<P: AsRef<Path>>(node: &XmlNode, file_path: P) -> Result<()> {
    let content = xml_node_to_string(node, 0);
    fs::write(&file_path, content)
        .context("Failed to write XML file")?;
    Ok(())
}

/// Serializes an XmlNode tree to a compact (no pretty-printing) XML string
/// 
/// # Arguments
/// * `node` - The root node to serialize
/// 
/// # Returns
/// A compact XML string without extra whitespace
pub fn xml_node_to_compact_string(node: &XmlNode) -> String {
    let mut output = String::new();
    serialize_node_compact(node, &mut output);
    output
}

/// Internal recursive function to serialize a node with formatting
fn serialize_node(node: &XmlNode, indent_level: usize, output: &mut String) {
    let indent = "  ".repeat(indent_level);
    
    // Opening tag with attributes
    output.push_str(&indent);
    output.push('<');
    output.push_str(&node.name);
    
    for (key, value) in &node.attributes {
        output.push(' ');
        output.push_str(key);
        output.push_str("=\"");
        output.push_str(&escape_xml_attr(value));
        output.push('"');
    }
    
    // Handle content: if there are children or text, open tag and add content
    if !node.children.is_empty() || !node.text_content.trim().is_empty() {
        output.push_str(">\n");
        
        // Add text content if present and non-empty
        if !node.text_content.trim().is_empty() {
            output.push_str(&indent);
            output.push_str("  ");
            output.push_str(&escape_xml_text(&node.text_content.trim()));
            output.push('\n');
        }
        
        // Recursively serialize children
        for child in &node.children {
            serialize_node(child, indent_level + 1, output);
        }
        
        // Closing tag
        output.push_str(&indent);
        output.push_str("</");
        output.push_str(&node.name);
        output.push_str(">\n");
    } else {
        // Self-closing tag for empty elements
        output.push_str(" />\n");
    }
}

/// Internal recursive function to serialize a node without formatting
fn serialize_node_compact(node: &XmlNode, output: &mut String) {
    output.push('<');
    output.push_str(&node.name);
    
    for (key, value) in &node.attributes {
        output.push(' ');
        output.push_str(key);
        output.push_str("=\"");
        output.push_str(&escape_xml_attr(value));
        output.push('"');
    }
    
    if !node.children.is_empty() || !node.text_content.trim().is_empty() {
        output.push('>');
        
        if !node.text_content.trim().is_empty() {
            output.push_str(&escape_xml_text(&node.text_content.trim()));
        }
        
        for child in &node.children {
            serialize_node_compact(child, output);
        }
        
        output.push_str("</");
        output.push_str(&node.name);
        output.push('>');
    } else {
        output.push_str(" />");
    }
}

/// Escapes special XML characters in attribute values
fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Escapes special XML characters in text content
fn escape_xml_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn create_test_node() -> XmlNode {
        let mut attrs = HashMap::new();
        attrs.insert("id".to_string(), "123".to_string());
        
        let mut child_attrs = HashMap::new();
        child_attrs.insert("name".to_string(), "test".to_string());
        
        let child = XmlNode {
            name: "child".to_string(),
            attributes: child_attrs,
            text_content: "Hello World".to_string(),
            children: vec![],
        };
        
        XmlNode {
            name: "root".to_string(),
            attributes: attrs,
            text_content: String::new(),
            children: vec![child],
        }
    }

    #[test]
    fn test_serialize_simple_node() {
        let node = create_test_node();
        let xml = xml_node_to_string(&node, 0);
        
        assert!(xml.contains("root"));
        assert!(xml.contains("id=\"123\""));
        assert!(xml.contains("child"));
        assert!(xml.contains("Hello World"));
        assert!(xml.contains("</root>"));
    }

    #[test]
    fn test_serialize_compact() {
        let node = create_test_node();
        let xml = xml_node_to_compact_string(&node);
        
        // Compact should not have newlines
        assert!(!xml.contains('\n'));
        assert!(xml.contains("root"));
        assert!(xml.contains("Hello World"));
    }

    #[test]
    fn test_escape_xml_chars() {
        let node = XmlNode {
            name: "test".to_string(),
            attributes: {
                let mut m = HashMap::new();
                m.insert("attr".to_string(), "value&quote\"lt<gt>".to_string());
                m
            },
            text_content: "text<with>special&chars".to_string(),
            children: vec![],
        };
        
        let xml = xml_node_to_string(&node, 0);
        assert!(xml.contains("&amp;"));
        assert!(xml.contains("&quot;"));
        assert!(xml.contains("&lt;"));
        assert!(xml.contains("&gt;"));
    }

    #[test]
    fn test_empty_element() {
        let node = XmlNode {
            name: "empty".to_string(),
            attributes: HashMap::new(),
            text_content: String::new(),
            children: vec![],
        };
        
        let xml = xml_node_to_string(&node, 0);
        assert!(xml.contains(" />"));
    }
}

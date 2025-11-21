/// XML serialization module - writes XmlNode structures back to XML files
/// 
/// This module provides fast serialization of parsed XML trees back to file format,
/// useful for validating parse fidelity, roundtrip testing, and performance benchmarking.

use crate::parse_xml::XmlNode;
use anyhow::{Result, Context};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use rayon::prelude::*;

/// Serializes an XmlNode and all its descendants to an XML string
/// 
/// # Arguments
/// * `node` - The root node to serialize
/// * `indent_level` - Starting indentation level (typically 0)
/// 
/// # Returns
/// A formatted XML string representation of the node tree
pub fn xml_node_to_string(node: &XmlNode, indent_level: usize) -> String {
    let mut buffer = Vec::with_capacity(1024);
    buffer.extend_from_slice(b"<?xml version=\"1.0\"?>\n");
    write_node_pretty(node, &mut buffer, indent_level).expect("serialization failed");
    String::from_utf8(buffer).expect("serialized XML was not valid UTF-8")
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
    let file = File::create(&file_path).context("Failed to create XML file")?;
    let mut writer = BufWriter::with_capacity(1024 * 1024, file); // Increased buffer to 1MB
    writer.write_all(b"<?xml version=\"1.0\"?>\n").context("Failed to write XML declaration")?;
    write_node_pretty(node, &mut writer, 0).context("Failed to serialize XML")?;
    writer.flush().context("Failed to flush XML writer")?;
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
    let mut buffer = Vec::with_capacity(1024);
    buffer.extend_from_slice(b"<?xml version=\"1.0\"?>\n");
    write_node_compact(node, &mut buffer).expect("serialization failed");
    String::from_utf8(buffer).expect("serialized XML was not valid UTF-8")
}

/// Internal recursive function to serialize a node with formatting
/// Uses parallel processing for nodes with many children (e.g. CadData)
fn write_node_pretty<W: Write>(node: &XmlNode, writer: &mut W, indent_level: usize) -> io::Result<()> {
    write_indent(writer, indent_level)?;
    writer.write_all(b"<")?;
    writer.write_all(node.name.as_bytes())?;

    for (key, value) in &node.attributes {
        writer.write_all(b" ")?;
        writer.write_all(key.as_bytes())?;
        writer.write_all(b"=\"")?;
        write_escaped_attr(writer, value)?;
        writer.write_all(b"\"")?;
    }

    let text = node.text_content.trim();
    let has_text = !text.is_empty();
    if node.children.is_empty() && !has_text {
        writer.write_all(b" />\n")?;
        return Ok(());
    }

    writer.write_all(b">\n")?;

    if has_text {
        write_indent(writer, indent_level + 1)?;
        write_escaped_text(writer, text)?;
        writer.write_all(b"\n")?;
    }

    // Parallelization threshold: if a node has many children (like CadData with layers),
    // serialize them in parallel to memory buffers, then write sequentially.
    // This significantly speeds up large board serialization.
    if node.children.len() > 64 {
        // Parallel processing
        let child_buffers: Result<Vec<Vec<u8>>, io::Error> = node.children.par_iter()
            .map(|child| {
                let mut buf = Vec::with_capacity(4096);
                write_node_pretty(child, &mut buf, indent_level + 1)?;
                Ok(buf)
            })
            .collect();

        for buf in child_buffers? {
            writer.write_all(&buf)?;
        }
    } else {
        // Serial processing
        for child in &node.children {
            write_node_pretty(child, writer, indent_level + 1)?;
        }
    }

    write_indent(writer, indent_level)?;
    writer.write_all(b"</")?;
    writer.write_all(node.name.as_bytes())?;
    writer.write_all(b">\n")?;
    Ok(())
}

/// Internal recursive function to serialize a node without formatting
fn write_node_compact<W: Write>(node: &XmlNode, writer: &mut W) -> io::Result<()> {
    writer.write_all(b"<")?;
    writer.write_all(node.name.as_bytes())?;

    for (key, value) in &node.attributes {
        writer.write_all(b" ")?;
        writer.write_all(key.as_bytes())?;
        writer.write_all(b"=\"")?;
        write_escaped_attr(writer, value)?;
        writer.write_all(b"\"")?;
    }

    let text = node.text_content.trim();
    let has_text = !text.is_empty();

    if node.children.is_empty() && !has_text {
        writer.write_all(b" />")?;
        return Ok(());
    }

    writer.write_all(b">")?;

    if has_text {
        write_escaped_text(writer, text)?;
    }

    for child in &node.children {
        write_node_compact(child, writer)?;
    }

    writer.write_all(b"</")?;
    writer.write_all(node.name.as_bytes())?;
    writer.write_all(b">")?;
    Ok(())
}

fn write_indent<W: Write>(writer: &mut W, indent_level: usize) -> io::Result<()> {
    for _ in 0..indent_level {
        writer.write_all(b"  ")?;
    }
    Ok(())
}

/// Escapes special XML characters in attribute values
fn write_escaped_attr<W: Write>(writer: &mut W, input: &str) -> io::Result<()> {
    let mut last = 0;
    for (idx, ch) in input.char_indices() {
        let entity = match ch {
            '&' => Some(b"&amp;" as &[u8]),
            '<' => Some(b"&lt;" as &[u8]),
            '>' => Some(b"&gt;" as &[u8]),
            '"' => Some(b"&quot;" as &[u8]),
            '\'' => Some(b"&apos;" as &[u8]),
            _ => None,
        };

        if let Some(bytes) = entity {
            if last < idx {
                writer.write_all(input[last..idx].as_bytes())?;
            }
            writer.write_all(bytes)?;
            last = idx + ch.len_utf8();
        }
    }

    if last < input.len() {
        writer.write_all(input[last..].as_bytes())?;
    }
    Ok(())
}

fn write_escaped_text<W: Write>(writer: &mut W, input: &str) -> io::Result<()> {
    let mut last = 0;
    for (idx, ch) in input.char_indices() {
        let entity = match ch {
            '&' => Some(b"&amp;" as &[u8]),
            '<' => Some(b"&lt;" as &[u8]),
            '>' => Some(b"&gt;" as &[u8]),
            _ => None,
        };

        if let Some(bytes) = entity {
            if last < idx {
                writer.write_all(input[last..idx].as_bytes())?;
            }
            writer.write_all(bytes)?;
            last = idx + ch.len_utf8();
        }
    }

    if last < input.len() {
        writer.write_all(input[last..].as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn create_test_node() -> XmlNode {
        let mut attrs = IndexMap::new();
        attrs.insert("id".to_string(), "123".to_string());
        
        let mut child_attrs = IndexMap::new();
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
        
        // Compact should have only the XML declaration newline
        let lines: Vec<&str> = xml.split('\n').collect();
        assert_eq!(lines.len(), 2); // XML declaration line + content line
        assert!(lines[0].contains("<?xml"));
        assert!(xml.contains("root"));
        assert!(xml.contains("Hello World"));
    }

    #[test]
    fn test_escape_xml_chars() {
        let node = XmlNode {
            name: "test".to_string(),
            attributes: {
                let mut m = IndexMap::new();
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
            attributes: IndexMap::new(),
            text_content: String::new(),
            children: vec![],
        };
        
        let xml = xml_node_to_string(&node, 0);
        assert!(xml.contains(" />"));
    }
}

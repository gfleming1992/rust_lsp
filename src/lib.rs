// Module declarations
pub mod parse_xml;
pub mod xml_to_sqlite;
pub mod serialize_xml;
pub mod xml_draw;
pub mod draw;
pub mod lsp;

// Re-export commonly used types and functions
pub use parse_xml::{XmlNode, parse_xml_file};
pub use serialize_xml::{xml_node_to_file, xml_node_to_string, xml_node_to_compact_string};
pub use xml_draw::extract_and_generate_layers;
pub use draw::geometry::{LayerJSON, LayerBinary};

/// Pretty-prints the XML tree structure
/// Useful for debugging and understanding parsed content
///
/// # Arguments
/// * `node` - The node to print
/// * `indent` - Current indentation level
pub fn print_xml_tree(node: &XmlNode, indent: usize) {
    let prefix = " ".repeat(indent);
    
    // Print the element name and attributes
    print!("{}<{}", prefix, node.name);
    
    // Print attributes if any exist
    if !node.attributes.is_empty() {
        for (key, value) in &node.attributes {
            print!(" {}=\"{}\"", key, value);
        }
    }
    
    println!(">");
    
    // Print text content if it exists and is non-empty
    if !node.text_content.trim().is_empty() {
        println!("{}{}", prefix, node.text_content.trim());
    }
    
    // Recursively print all children
    for child in &node.children {
        print_xml_tree(child, indent + 2);
    }
    
    // Print closing tag
    println!("{}</{}>", prefix, node.name);
}

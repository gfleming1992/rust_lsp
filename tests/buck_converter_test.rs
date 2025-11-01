// Import the library functions
use rust_extension::{parse_xml_file, print_xml_tree};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_48v_24v_buck_converter_parsing() {
        let xml_path = "tests/48V-24V Buck Converter.xml";
        let result = parse_xml_file(xml_path);
        assert!(result.is_ok(), "Failed to parse XML: {:?}", result.err());
        
        let root = result.unwrap();
        assert_eq!(root.name, "IPC-2581", "Expected root element to be IPC-2581");
        assert!(!root.attributes.is_empty(), "Root element should have attributes");
        
        println!("✓ Successfully parsed 48V-24V Buck Converter.xml");
        println!("  Root element: {}", root.name);
        println!("  Number of child elements: {}", root.children.len());
        println!("\nParsed structure:");
        print_xml_tree(&root, 0);
    }
}

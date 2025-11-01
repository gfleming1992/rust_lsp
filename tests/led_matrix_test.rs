// Import the library functions
use rust_extension::{parse_xml_file, print_xml_tree};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_led_matrix_parsing() {
        let xml_path = "tests/LED Matrix.xml";
        let result = parse_xml_file(xml_path);
        assert!(result.is_ok(), "Failed to parse XML: {:?}", result.err());
        
        let root = result.unwrap();
        assert_eq!(root.name, "IPC-2581", "Expected root element to be IPC-2581");
        assert!(!root.attributes.is_empty(), "Root element should have attributes");
        
        println!("✓ Successfully parsed LED Matrix.xml");
        println!("  Root element: {}", root.name);
        println!("  Number of child elements: {}", root.children.len());
        println!("\nParsed structure:");
        print_xml_tree(&root, 0);
    }
}

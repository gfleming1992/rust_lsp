// Import the library functions
use rust_extension::{parse_xml_file, print_xml_tree, xml_node_to_file};
use std::time::Instant;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_48v_24v_buck_converter_parsing() {
        let xml_path = "tests/48V-24V Buck Converter.xml";
        let start = Instant::now();
        let result = parse_xml_file(xml_path);
        let elapsed = start.elapsed();
        assert!(result.is_ok(), "Failed to parse XML: {:?}", result.err());
        
        let root = result.unwrap();
        assert_eq!(root.name, "IPC-2581", "Expected root element to be IPC-2581");
        assert!(!root.attributes.is_empty(), "Root element should have attributes");
        
        println!("✓ Successfully parsed 48V-24V Buck Converter.xml");
        println!("  Root element: {}", root.name);
        println!("  Number of child elements: {}", root.children.len());
        println!("Parsing time: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
        #[cfg(debug_assertions)]
        {
            println!("\nParsed structure:");
            print_xml_tree(&root, 0);
        }
    }

    #[test]
    fn test_buck_converter_serialization() {
        let xml_path = "tests/48V-24V Buck Converter.xml";
        let root = parse_xml_file(xml_path).expect("Failed to parse XML");
        
        let start = Instant::now();
        let output_path = "output/48V-24V Buck Converter_serialized.xml";
        xml_node_to_file(&root, output_path).expect("Failed to serialize XML");
        let elapsed = start.elapsed();
        
        println!("\n=== XML Serialization Performance ===");
        println!("File: 48V-24V Buck Converter.xml");
        println!("Serialization time: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
        println!("Output: {}", output_path);
        
        // Verify output file exists and has content
        assert!(std::path::Path::new(output_path).exists(), "Output file not created");
        let file_size = std::fs::metadata(output_path).unwrap().len();
        println!("Output file size: {} bytes", file_size);
        assert!(file_size > 0, "Output file is empty");
    }
}

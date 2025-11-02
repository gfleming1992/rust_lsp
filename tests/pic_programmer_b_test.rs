// Import the library functions
use rust_extension::{parse_xml_file, print_xml_tree, xml_node_to_file};
use std::time::Instant;

#[cfg(test)]
mod tests {
    use super::*;

    /// Test parsing the pic_programmerB.xml file
    /// This demonstrates:
    /// 1. Loading an XML file from disk
    /// 2. Parsing it into an in-memory tree structure
    /// 3. Accessing the parsed data
    #[test]
    fn test_pic_programmer_b_parsing() {
        // Define the path to the XML file we want to parse
        let xml_path = "tests/pic_programmerB.xml";
        
        // Parse the XML file using the library function
        let start = Instant::now();
        let result = parse_xml_file(xml_path);
        let elapsed = start.elapsed();
        
        // Assert that parsing was successful
        // If this fails, the test will print the error message
        assert!(result.is_ok(), "Failed to parse XML: {:?}", result.err());
        
        // Unwrap the Result to get the root node
        let root = result.unwrap();
        
        // Verify the root element name is what we expect
        // In IPC-2581 files, the root should be "IPC-2581"
        assert_eq!(root.name, "IPC-2581", "Expected root element to be IPC-2581");
        
        // Check that the root has attributes (should have revision, xmlns, etc.)
        assert!(!root.attributes.is_empty(), "Root element should have attributes");
        
        // Check for the revision attribute specifically
        assert!(root.attributes.contains_key("revision"), "Should have revision attribute");
        let revision = root.attributes.get("revision").unwrap();
        assert_eq!(revision, "B", "Expected revision B");
        
        // Print some debug information about the parsed tree
        println!("✓ Successfully parsed IPC-2581 document");
        println!("  Root element: {}", root.name);
        println!("  Revision: {}", revision);
        println!("  Number of child elements: {}", root.children.len());
        println!("Parsing time: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
        
        // Print the first few elements to show the tree structure
        if !root.children.is_empty() {
            println!("  First child: {}", root.children[0].name);
        }
        
        // Optional: Print the full tree structure for inspection
        // Only printed in debug mode to avoid release mode overhead
        #[cfg(debug_assertions)]
        {
            println!("\nFull parsed structure:");
            print_xml_tree(&root, 0);
        }
    }

    /// Alternative test that demonstrates inspecting parsed content
    #[test]
    fn test_pic_programmer_b_content_inspection() {
        let xml_path = "tests/pic_programmerB.xml";
        let root = parse_xml_file(xml_path)
            .expect("Failed to parse XML");
        
        // Count the number of children at the root level
        let child_count = root.children.len();
        println!("Root has {} children", child_count);
        
        // Print all direct children of root
        for child in &root.children {
            println!("  - {}", child.name);
        }
        
        // Look for specific elements (recursively search tree)
        let found_content = search_for_element(&root, "Content");
        
        println!("Found Content element: {}", found_content);
        // Just verify we successfully parsed something meaningful
        assert!(!root.name.is_empty(), "Root should have a name");
    }

    #[test]
    fn test_pic_programmer_b_serialization() {
        let xml_path = "tests/pic_programmerB.xml";
        let root = parse_xml_file(xml_path).expect("Failed to parse XML");
        
        let start = Instant::now();
        let output_path = "output/pic_programmerB_serialized.xml";
        xml_node_to_file(&root, output_path).expect("Failed to serialize XML");
        let elapsed = start.elapsed();
        
        println!("\n=== XML Serialization Performance ===");
        println!("File: pic_programmerB.xml");
        println!("Serialization time: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
        println!("Output: {}", output_path);
        
        // Verify output file exists and has content
        assert!(std::path::Path::new(output_path).exists(), "Output file not created");
        let file_size = std::fs::metadata(output_path).unwrap().len();
        println!("Output file size: {} bytes", file_size);
        assert!(file_size > 0, "Output file is empty");
    }
}

/// Helper function to recursively search for an element by name
fn search_for_element(node: &rust_extension::XmlNode, target: &str) -> bool {
    if node.name == target {
        return true;
    }
    
    for child in &node.children {
        if search_for_element(child, target) {
            return true;
        }
    }
    
    false
}


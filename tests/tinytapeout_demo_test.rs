// Import the library functions
use rust_extension::{parse_xml_file, print_xml_tree, xml_node_to_file, extract_and_generate_layers};
use std::time::Instant;
use std::fs;
use serde_json;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tinytapeout_demo_parsing() {
        let xml_path = "tests/tinytapeout-demo.xml";
        let start = Instant::now();
        let result = parse_xml_file(xml_path);
        let elapsed = start.elapsed();
        assert!(result.is_ok(), "Failed to parse XML: {:?}", result.err());
        
        let root = result.unwrap();
        assert_eq!(root.name, "IPC-2581", "Expected root element to be IPC-2581");
        assert!(!root.attributes.is_empty(), "Root element should have attributes");
        
        println!("✓ Successfully parsed tinytapeout-demo.xml");
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
    fn test_tinytapeout_demo_serialization() {
        let xml_path = "tests/tinytapeout-demo.xml";
        let root = parse_xml_file(xml_path).expect("Failed to parse XML");
        
        let start = Instant::now();
        let output_path = "output/tinytapeout-demo_serialized.xml";
        xml_node_to_file(&root, output_path).expect("Failed to serialize XML");
        let elapsed = start.elapsed();
        
        println!("\n=== XML Serialization Performance ===");
        println!("File: tinytapeout-demo.xml");
        println!("Serialization time: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
        println!("Output: {}", output_path);
        
        // Verify output file exists and has content
        assert!(std::path::Path::new(output_path).exists(), "Output file not created");
        let file_size = std::fs::metadata(output_path).unwrap().len();
        println!("Output file size: {} bytes", file_size);
        assert!(file_size > 0, "Output file is empty");
    }

    #[test]
    fn test_tinytapeout_demo_tessellation() {
        let xml_path = "tests/tinytapeout-demo.xml";
        let root = parse_xml_file(xml_path).expect("Failed to parse XML");
        
        println!("\n=== XML Tessellation & LOD Generation ===");
        println!("File: tinytapeout-demo.xml");
        
        let start = Instant::now();
        let layer_jsons = extract_and_generate_layers(&root)
            .expect("Failed to extract layers and generate LODs");
        let tessellation_time = start.elapsed();
        
        println!("Tessellation time: {:.3}ms", tessellation_time.as_secs_f64() * 1000.0);
        println!("Layers found: {}", layer_jsons.len());
        
        // Ensure output directory exists
        fs::create_dir_all("output").expect("Failed to create output directory");
        
        // Write each layer to JSON file
        let mut total_bytes = 0;
        for layer_json in &layer_jsons {
            let filename = format!("webview/src/test-data/layer_{}.json", layer_json.layer_id.replace(":", "_"));
            let json_str = serde_json::to_string_pretty(&layer_json)
                .expect("Failed to serialize layer JSON");
            
            fs::write(&filename, &json_str)
                .expect(&format!("Failed to write {}", filename));
            
            let file_size = json_str.len();
            total_bytes += file_size;
            
            // Count LODs written
            let lod_count = layer_json.geometry.batch.as_ref().map(|b| b.len()).unwrap_or(0);
            println!("  {} - {} LODs, {:.2} KB", 
                     layer_json.layer_id, 
                     lod_count, 
                     file_size as f32 / 1024.0);
        }
        
        println!("\nTotal JSON written: {:.2} MB", total_bytes as f32 / 1_048_576.0);
        
        // Verify files were created
        assert!(layer_jsons.len() > 0, "No layers found");
        for layer_json in &layer_jsons {
            let filename = format!("output/layer_{}.json", layer_json.layer_id.replace(":", "_"));
            assert!(std::path::Path::new(&filename).exists(), 
                   "Layer JSON file {} not created", filename);
        }
    }
}

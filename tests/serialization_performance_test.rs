use rust_extension::{parse_xml_file, xml_node_to_file};
use std::time::Instant;
use std::fs;
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nex40400_probecard_serialization_performance() {
        let xml_path = "tests/NEX40400_PROBECARD_PCB.xml";
        let output_path = "output/NEX40400_PROBECARD_PCB_serialized.xml";
        
        // Ensure output directory exists
        if !Path::new("output").exists() {
            fs::create_dir("output").expect("Failed to create output directory");
        }

        println!("\n=== XML Serialization Performance Test ===");
        println!("Input File: {}", xml_path);
        
        // 1. Parse
        let parse_start = Instant::now();
        let root = parse_xml_file(xml_path).expect("Failed to parse XML");
        let parse_time = parse_start.elapsed();
        println!("Parsing time: {:.3}ms", parse_time.as_secs_f64() * 1000.0);
        
        // 2. Serialize
        let serialize_start = Instant::now();
        xml_node_to_file(&root, output_path).expect("Failed to serialize XML");
        let serialize_time = serialize_start.elapsed();
        
        println!("Serialization time: {:.3}ms", serialize_time.as_secs_f64() * 1000.0);
        println!("Output File: {}", output_path);
        
        // 3. Verify
        let metadata = fs::metadata(output_path).expect("Failed to get output file metadata");
        println!("Output Size: {:.2} MB", metadata.len() as f64 / (1024.0 * 1024.0));
        
        println!("=== TOTAL ROUNDTRIP TIME: {:.3}ms ===", (parse_time + serialize_time).as_secs_f64() * 1000.0);
    }
}

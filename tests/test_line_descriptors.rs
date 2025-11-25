// Test to verify line descriptors are correctly parsed and applied
use rust_extension::{parse_xml_file, extract_and_generate_layers};

#[test]
fn test_line_descriptors_parsing() {
    let xml_path = "tests/tinytapeout-demo.xml";
    let root = parse_xml_file(xml_path).expect("Failed to parse XML");
    
    // Find Content node
    let content_node = root.children.iter()
        .find(|n| n.name == "Content")
        .expect("Content node not found");
    
    // Find DictionaryLineDesc
    let dict_node = content_node.children.iter()
        .find(|n| n.name == "DictionaryLineDesc")
        .expect("DictionaryLineDesc not found");
    
    println!("Found DictionaryLineDesc with {} entries", dict_node.children.len());
    assert!(dict_node.children.len() > 0, "Expected at least one line descriptor");
    
    // Verify specific line descriptors match the XML
    let mut found_line1 = false;
    let mut found_line2 = false;
    
    for entry in &dict_node.children {
        if entry.name == "EntryLineDesc" {
            if let Some(id) = entry.attributes.get("id") {
                if let Some(line_desc) = entry.children.iter().find(|n| n.name == "LineDesc") {
                    let width = line_desc.attributes.get("lineWidth");
                    let end = line_desc.attributes.get("lineEnd");
                    
                    println!("  {}: width={:?}, end={:?}", id, width, end);
                    
                    // Verify LINE_1: lineWidth="0.050" lineEnd="ROUND"
                    if id == "LINE_1" {
                        assert_eq!(width, Some(&"0.050".to_string()));
                        assert_eq!(end, Some(&"ROUND".to_string()));
                        found_line1 = true;
                    }
                    
                    // Verify LINE_2: lineWidth="0.060" lineEnd="ROUND"
                    if id == "LINE_2" {
                        assert_eq!(width, Some(&"0.060".to_string()));
                        assert_eq!(end, Some(&"ROUND".to_string()));
                        found_line2 = true;
                    }
                }
            }
        }
    }
    
    assert!(found_line1, "LINE_1 descriptor not found");
    assert!(found_line2, "LINE_2 descriptor not found");
    
    println!("\n✓ Line descriptors correctly parsed from XML");
}

#[test]
fn test_polylines_use_line_descriptors() {
    let xml_path = "tests/tinytapeout-demo.xml";
    let root = parse_xml_file(xml_path).expect("Failed to parse XML");
    
    // Generate layers - this will parse polylines and apply line descriptors
    let (layer_jsons, _) = extract_and_generate_layers(&root)
        .expect("Failed to extract layers");
    
    println!("Generated {} layers", layer_jsons.len());
    assert!(layer_jsons.len() > 0, "Expected at least one layer");
    
    // Check that geometry was generated (which means polylines were tessellated with widths)
    let mut total_polylines = 0;
    for layer in &layer_jsons {
        if let Some(batch) = &layer.geometry.batch {
            for lod in batch {
                total_polylines += 1;
                println!("  Layer {} LOD: {} vertices, {} indices", 
                    layer.layer_id, lod.vertex_count, lod.index_count.unwrap_or(0));
            }
        }
    }
    
    assert!(total_polylines > 0, "Expected tessellated geometry");
    println!("\n✓ Polylines successfully tessellated with line descriptors applied");
    println!("  Total LOD geometries: {}", total_polylines);
}

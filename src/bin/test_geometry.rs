//! CLI tool for testing geometry extraction and tessellation without the GUI
//! 
//! Usage:
//!   cargo run --release --bin test_geometry -- <xml_file> [options]
//! 
//! Options:
//!   --layer <name>      Filter to specific layer
//!   --region <x1,y1,x2,y2>  Filter to bounding box region
//!   --type <pad|via|polyline|all>  Filter by geometry type
//!   --summary           Show summary stats only
//!   --verbose           Show detailed geometry info

use std::env;

use rust_extension::parse_xml::parse_xml_file;
use rust_extension::xml_draw::extract_and_generate_layers;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    
    if args.len() < 2 {
        eprintln!("Usage: {} <xml_file> [options]", args[0]);
        eprintln!();
        eprintln!("Options:");
        eprintln!("  --layer <name>           Filter to specific layer (partial match)");
        eprintln!("  --region <x1,y1,x2,y2>   Filter to bounding box region");
        eprintln!("  --type <pad|via|polyline|polygon|all>  Filter by geometry type (default: all)");
        eprintln!("  --coord <x,y>            Find objects near coordinate (tolerance 1.0)");
        eprintln!("  --summary                Show summary stats only");
        eprintln!("  --verbose                Show detailed geometry info");
        eprintln!();
        eprintln!("Examples:");
        eprintln!("  {} test.xml --summary", args[0]);
        eprintln!("  {} test.xml --layer \"Top Layer\" --type pad", args[0]);
        eprintln!("  {} test.xml --coord 235.17,156.55 --verbose", args[0]);
        eprintln!("  {} test.xml --region 230,150,240,160 --type via", args[0]);
        return Ok(());
    }
    
    let xml_path = &args[1];
    
    // Parse options
    let mut layer_filter: Option<String> = None;
    let mut region_filter: Option<(f32, f32, f32, f32)> = None;
    let mut coord_filter: Option<(f32, f32)> = None;
    let mut type_filter = "all".to_string();
    let mut summary_only = false;
    let mut verbose = false;
    
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--layer" => {
                i += 1;
                if i < args.len() {
                    layer_filter = Some(args[i].clone());
                }
            }
            "--region" => {
                i += 1;
                if i < args.len() {
                    let parts: Vec<&str> = args[i].split(',').collect();
                    if parts.len() == 4 {
                        region_filter = Some((
                            parts[0].parse()?,
                            parts[1].parse()?,
                            parts[2].parse()?,
                            parts[3].parse()?,
                        ));
                    }
                }
            }
            "--coord" => {
                i += 1;
                if i < args.len() {
                    let parts: Vec<&str> = args[i].split(',').collect();
                    if parts.len() == 2 {
                        coord_filter = Some((
                            parts[0].parse()?,
                            parts[1].parse()?,
                        ));
                    }
                }
            }
            "--type" => {
                i += 1;
                if i < args.len() {
                    type_filter = args[i].clone();
                }
            }
            "--summary" => summary_only = true,
            "--verbose" => verbose = true,
            _ => {}
        }
        i += 1;
    }
    
    // Load and parse XML
    eprintln!("Loading: {}", xml_path);
    
    let start = std::time::Instant::now();
    let root = parse_xml_file(xml_path)?;
    eprintln!("XML parsed in {:.2}ms", start.elapsed().as_secs_f64() * 1000.0);
    
    let start = std::time::Instant::now();
    let (layers, ranges) = extract_and_generate_layers(&root)?;
    eprintln!("Layers extracted in {:.2}ms", start.elapsed().as_secs_f64() * 1000.0);
    eprintln!();
    
    // Process each layer
    let mut total_pads = 0usize;
    let mut total_vias = 0usize;
    let mut total_objects = ranges.len();
    
    for layer in &layers {
        let layer_name = &layer.layer_name;
        
        // Apply layer filter
        if let Some(ref filter) = layer_filter {
            if !layer_name.to_lowercase().contains(&filter.to_lowercase()) {
                continue;
            }
        }
        
        let has_instanced_rot = layer.geometry.instanced_rot.is_some();
        let has_instanced = layer.geometry.instanced.is_some();
        let has_batch = layer.geometry.batch.is_some();
        
        // Count instances from LOD0 only (each shape appears 3 times for 3 LODs)
        let pad_count = if has_instanced_rot { 
            layer.geometry.instanced_rot.as_ref().map(|lods| {
                // LOD0 entries are first third of the array
                let num_shapes = lods.len() / 3;
                lods.iter().take(num_shapes)
                    .filter_map(|l| l.instance_count)
                    .sum::<usize>()
            }).unwrap_or(0)
        } else { 0 };
        
        let via_count = if has_instanced {
            layer.geometry.instanced.as_ref().map(|lods| {
                let num_shapes = lods.len() / 3;
                lods.iter().take(num_shapes)
                    .filter_map(|l| l.instance_count)
                    .sum::<usize>()
            }).unwrap_or(0)
        } else { 0 };
        
        total_pads += pad_count;
        total_vias += via_count;
        
        if summary_only {
            if pad_count > 0 || via_count > 0 || has_batch {
                println!("{}: pads={}, vias={}, has_batch={}", 
                    layer_name, pad_count, via_count, has_batch);
            }
        } else {
            println!("=== Layer: {} ===", layer_name);
            println!("  Color: {:?}", layer.default_color);
            println!("  Has batch geometry: {}", has_batch);
            println!("  Has instanced (vias): {}", has_instanced);
            println!("  Has instanced_rot (pads): {}", has_instanced_rot);
            
            // Show instanced_rot (pad) details
            if has_instanced_rot && (type_filter == "all" || type_filter == "pad") {
                if let Some(lods) = &layer.geometry.instanced_rot {
                    let num_shapes = lods.len() / 3;
                    println!("  Pad shapes: {} (x3 LODs = {} entries)", num_shapes, lods.len());
                    
                    // Show LOD0 entries only
                    for (idx, lod) in lods.iter().take(num_shapes).enumerate() {
                        if let Some(count) = lod.instance_count {
                            if count > 0 || verbose {
                                println!("    Shape[{}]: {} instances, {} vertices, {} indices", 
                                    idx, count, lod.vertex_count, 
                                    lod.index_count.unwrap_or(0));
                            }
                        }
                    }
                }
            }
            
            // Show instanced (via) details  
            if has_instanced && (type_filter == "all" || type_filter == "via") {
                if let Some(lods) = &layer.geometry.instanced {
                    let num_shapes = lods.len() / 3;
                    println!("  Via shapes: {} (x3 LODs = {} entries)", num_shapes, lods.len());
                    
                    for (idx, lod) in lods.iter().take(num_shapes).enumerate() {
                        if let Some(count) = lod.instance_count {
                            if count > 0 || verbose {
                                println!("    Shape[{}]: {} instances, {} vertices, {} indices",
                                    idx, count, lod.vertex_count,
                                    lod.index_count.unwrap_or(0));
                            }
                        }
                    }
                }
            }
            
            println!();
        }
    }
    
    println!();
    println!("=== Summary ===");
    println!("  Layers: {}", layers.len());
    println!("  Total pads: {}", total_pads);
    println!("  Total vias: {}", total_vias);
    println!("  Total object ranges: {}", total_objects);
    
    // Filter ranges by region/coord if specified
    if let Some((x1, y1, x2, y2)) = region_filter {
        println!();
        println!("=== Objects in region ({},{}) to ({},{}) ===", x1, y1, x2, y2);
        let filtered: Vec<_> = ranges.iter()
            .filter(|r| {
                let [min_x, min_y, max_x, max_y] = r.bounds;
                // Check if object overlaps with region
                min_x <= x2 && max_x >= x1 && min_y <= y2 && max_y >= y1
            })
            .collect();
        
        println!("  Found {} objects", filtered.len());
        for r in filtered.iter().take(20) {
            let type_name = match r.obj_type {
                1 => "polyline",
                2 => "via",
                3 => "pad",
                4 => "polygon",
                _ => "unknown",
            };
            println!("    {} @ ({:.2},{:.2})-({:.2},{:.2}) layer={} net={:?}",
                type_name,
                r.bounds[0], r.bounds[1], r.bounds[2], r.bounds[3],
                r.layer_id,
                r.net_name);
        }
        if filtered.len() > 20 {
            println!("    ... and {} more", filtered.len() - 20);
        }
    }
    
    if let Some((cx, cy)) = coord_filter {
        let tolerance = 2.0;
        println!();
        println!("=== Objects near ({},{}) (tolerance {}) ===", cx, cy, tolerance);
        let filtered: Vec<_> = ranges.iter()
            .filter(|r| {
                let [min_x, min_y, max_x, max_y] = r.bounds;
                let obj_cx = (min_x + max_x) / 2.0;
                let obj_cy = (min_y + max_y) / 2.0;
                (obj_cx - cx).abs() <= tolerance && (obj_cy - cy).abs() <= tolerance
            })
            .collect();
        
        println!("  Found {} objects", filtered.len());
        for r in &filtered {
            let type_name = match r.obj_type {
                1 => "polyline",
                2 => "via", 
                3 => "pad",
                4 => "polygon",
                _ => "unknown",
            };
            println!("    {} @ ({:.2},{:.2})-({:.2},{:.2}) layer={} net={:?} comp={:?}",
                type_name,
                r.bounds[0], r.bounds[1], r.bounds[2], r.bounds[3],
                r.layer_id,
                r.net_name,
                r.component_ref);
        }
    }
    
    Ok(())
}

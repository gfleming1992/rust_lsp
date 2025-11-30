//! XML parsing module for IPC-2581 PCB data
//!
//! This module parses IPC-2581 XML format and extracts geometry data for rendering.
//!
//! # Submodules
//! - `colors` - Color parsing and layer color assignment
//! - `descriptors` - Line descriptor and layer function parsing  
//! - `primitives` - Standard primitive and padstack definition parsing
//! - `polylines` - Polyline and line node parsing
//! - `polygons` - Polygon and contour parsing
//! - `padstacks` - Pad and via collection from layers

mod colors;
mod descriptors;
mod primitives;
mod polylines;
mod polygons;
mod padstacks;

use crate::draw::geometry::*;
use crate::draw::generation::*;
use crate::draw::tessellation::MIN_VISIBLE_WIDTH_LOD;
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use rayon::prelude::*;
use std::collections::HashSet;

// Re-export key parsing functions
pub use colors::get_layer_color;
pub use descriptors::{parse_line_descriptors, parse_layer_functions};
pub use primitives::{parse_standard_primitives, parse_padstack_definitions};

/// Extract all LayerFeatures from XML root and generate LayerJSON for each
pub fn extract_and_generate_layers(root: &XmlNode) -> Result<(Vec<LayerJSON>, Vec<ObjectRange>), anyhow::Error> {
    let total_start = std::time::Instant::now();
    let mut layers_seen = HashSet::new();

    // Parse line descriptors from DictionaryLineDesc
    let parse_start = std::time::Instant::now();
    let line_descriptors = descriptors::parse_line_descriptors(root);
    let parse_time = parse_start.elapsed();
    
    // Parse standard primitive definitions (circles, rectangles, etc.)
    let primitives = primitives::parse_standard_primitives(root);
    
    // Parse padstack definitions (for vias)
    let padstack_defs = primitives::parse_padstack_definitions(root);
    
    // Parse layer functions from Layer elements (SIGNAL, CONDUCTOR, PLANE, etc.)
    let layer_functions = descriptors::parse_layer_functions(root);
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("\n=== Detailed Timing Profile ===");
        eprintln!("Line descriptor parsing: {:.2}ms", parse_time.as_secs_f64() * 1000.0);
        eprintln!("Parsed {} standard primitives", primitives.len());
        eprintln!("Parsed {} padstack definitions", padstack_defs.len());
        eprintln!("Parsed {} layer functions", layer_functions.len());
    }

    // Find Ecad node which contains all the CAD data
    let ecad_node = root
        .children
        .iter()
        .find(|n| n.name == "Ecad")
        .ok_or_else(|| anyhow::anyhow!("No Ecad node found"))?;

    // Find CadData node within Ecad
    let cad_data = ecad_node
        .children
        .iter()
        .find(|n| n.name == "CadData")
        .ok_or_else(|| anyhow::anyhow!("No CadData node found"))?;

    // 1. Collect all LayerFeature nodes and their geometries (Sequential)
    let collect_start = std::time::Instant::now();
    let mut layer_contexts = IndexMap::new();
    collect_layer_features(cad_data, &mut layer_contexts, &mut layers_seen, &line_descriptors, &padstack_defs)?;
    
    // Also collect PadStack instances from Step (vias defined at Step level)
    padstacks::collect_padstacks_from_step(cad_data, &mut layer_contexts, &primitives);
    
    let collect_time = collect_start.elapsed();

    // 2. Process layers in parallel (Parallel)
    let process_start = std::time::Instant::now();
    
    // Use rayon to process layers in parallel
    let results: Vec<Result<(LayerJSON, Vec<ObjectRange>, CullingStats), anyhow::Error>> = layer_contexts
        .into_iter()
        .collect::<Vec<_>>()
        .into_par_iter()
        .enumerate()
        .map(|(idx, (layer_ref, geometries))| {
            let mut local_culling_stats = CullingStats::default();
            
            // Extract layer name from layerRef (e.g., "LAYER:Design" -> "Design")
            let layer_name = layer_ref
                .split(':')
                .next_back()
                .unwrap_or(&layer_ref)
                .to_string();
            
            // Generate default color based on layer type
            let color = colors::get_layer_color(&layer_ref);
            
            // Look up layer function (default to empty string if not found)
            let layer_function = layer_functions.get(&layer_ref)
                .or_else(|| layer_functions.get(&layer_name))
                .map(|s| s.as_str())
                .unwrap_or("");
            
            let (layer_json, object_ranges) = generate_layer_json(
                &layer_ref,
                idx as u32,
                &layer_name,
                layer_function,
                color,
                &geometries,
                &mut local_culling_stats,
                &primitives,
            )?;
            
            Ok((layer_json, object_ranges, local_culling_stats))
        })
        .collect();

    // 3. Aggregate results and stats
    let mut layer_jsons = Vec::with_capacity(results.len());
    let mut all_object_ranges = Vec::new();
    let mut total_culling_stats = CullingStats::default();
    
    for result in results {
        let (layer_json, ranges, stats) = result?;
        layer_jsons.push(layer_json);
        all_object_ranges.extend(ranges);
        
        // Aggregate stats
        total_culling_stats.total_polylines += stats.total_polylines;
        for i in 0..5 {
            total_culling_stats.lod_culled[i] += stats.lod_culled[i];
        }
    }
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("\nTotal collection time: {:.2}ms", collect_time.as_secs_f64() * 1000.0);
        eprintln!("Parallel processing time: {:.2}ms", process_start.elapsed().as_secs_f64() * 1000.0);
        eprintln!("TOTAL TESSELLATION TIME: {:.2}ms\n", total_start.elapsed().as_secs_f64() * 1000.0);
    }

    // Print culling summary only when PROFILE_TIMING is set
    if std::env::var("PROFILE_TIMING").is_ok() && total_culling_stats.lod_culled.iter().any(|&c| c > 0) {
        eprintln!("\n=== Width-Based Culling Summary ===");
        eprintln!("Total polylines across all layers: {}", total_culling_stats.total_polylines);
        for (lod, count) in total_culling_stats.lod_culled.iter().enumerate() {
            if *count > 0 {
                let percent = (*count as f32 / total_culling_stats.total_polylines as f32) * 100.0;
                eprintln!(
                    "  LOD{}: {} polylines culled ({:.1}%, width < {:.3})",
                    lod, count, percent, MIN_VISIBLE_WIDTH_LOD[lod]
                );
            }
        }
    }

    Ok((layer_jsons, all_object_ranges))
}

/// Recursively find LayerFeature nodes and collect geometries for each unique layer
fn collect_layer_features(
    node: &XmlNode,
    layer_contexts: &mut IndexMap<String, LayerGeometries>,
    layers_seen: &mut HashSet<String>,
    line_descriptors: &IndexMap<String, LineDescriptor>,
    padstack_defs: &IndexMap<String, PadStackDef>,
) -> Result<(), anyhow::Error> {
    // If this is a LayerFeature node, process it
    if node.name == "LayerFeature" {
        if let Some(layer_ref) = node.attributes.get("layerRef") {
            if !layers_seen.contains(layer_ref) {
                layers_seen.insert(layer_ref.clone());
                
                // Collect all geometries from this LayerFeature
                let mut geometries = LayerGeometries {
                    layer_ref: layer_ref.clone(),
                    polylines: Vec::new(),
                    polygons: Vec::new(),
                    padstack_holes: Vec::new(),
                    pads: Vec::new(),
                    vias: Vec::new(),
                };
                collect_geometries_from_node(node, &mut geometries, line_descriptors, padstack_defs);
                
                // Only add layer if it has any geometry
                if !geometries.polylines.is_empty() || !geometries.polygons.is_empty() || !geometries.padstack_holes.is_empty() || !geometries.pads.is_empty() || !geometries.vias.is_empty() {
                    layer_contexts.insert(layer_ref.clone(), geometries);
                }
            }
        }
    }

    // Recursively search all children
    for child in &node.children {
        collect_layer_features(child, layer_contexts, layers_seen, line_descriptors, padstack_defs)?;
    }

    Ok(())
}

/// Recursively collect all geometry elements from a specific node
fn collect_geometries_from_node(
    node: &XmlNode,
    geometries: &mut LayerGeometries,
    line_descriptors: &IndexMap<String, LineDescriptor>,
    padstack_defs: &IndexMap<String, PadStackDef>,
) {
    // Start with no net or component context
    collect_geometries_with_context(node, geometries, line_descriptors, padstack_defs, None, None);
}

/// Recursively collect all geometry elements, tracking the current net and component context from Set nodes
fn collect_geometries_with_context(
    node: &XmlNode,
    geometries: &mut LayerGeometries,
    line_descriptors: &IndexMap<String, LineDescriptor>,
    padstack_defs: &IndexMap<String, PadStackDef>,
    current_net: Option<&str>,
    current_component: Option<&str>,
) {
    // Check if this node is a Set with a net or componentRef attribute
    let net_context = if node.name == "Set" {
        node.attributes.get("net").map(|s| s.as_str()).or(current_net)
    } else {
        current_net
    };
    
    let component_context = if node.name == "Set" {
        node.attributes.get("componentRef").map(|s| s.as_str()).or(current_component)
    } else {
        current_component
    };
    
    // If this is a Polyline node, parse it
    if node.name == "Polyline" {
        if let Ok(mut polyline) = polylines::parse_polyline_node(node, line_descriptors) {
            polyline.net_name = net_context.map(|s| s.to_string());
            polyline.component_ref = component_context.map(|s| s.to_string());
            geometries.polylines.push(polyline);
        }
    } else if node.name == "Line" {
        if let Ok(mut line_polyline) = polylines::parse_line_node(node, line_descriptors) {
            line_polyline.net_name = net_context.map(|s| s.to_string());
            line_polyline.component_ref = component_context.map(|s| s.to_string());
            geometries.polylines.push(line_polyline);
        }
    } else if node.name == "Polygon" {
        // Parse filled polygon shapes
        if let Ok(mut polygon) = polygons::parse_polygon_node(node) {
            polygon.net_name = net_context.map(|s| s.to_string());
            polygon.component_ref = component_context.map(|s| s.to_string());
            geometries.polygons.push(polygon);
        }
    } else if node.name == "Contour" {
        // Parse Contour elements (polygon with cutouts for copper pours)
        if let Ok(mut polygon) = polygons::parse_contour_node(node) {
            polygon.net_name = net_context.map(|s| s.to_string());
            polygon.component_ref = component_context.map(|s| s.to_string());
            geometries.polygons.push(polygon);
        }
        return; // Don't recurse - we've already processed Polygon and Cutout children
    } else if node.name == "LayerFeature" {
        // Collect pads and vias from this layer (they handle their own net context)
        let pads = padstacks::collect_pads_from_layer(node, padstack_defs);
        geometries.pads.extend(pads);
        
        let vias = padstacks::collect_vias_from_layer(node, padstack_defs);
        geometries.vias.extend(vias);
    }

    // Recursively search all children, passing down the net and component context
    for child in &node.children {
        collect_geometries_with_context(child, geometries, line_descriptors, padstack_defs, net_context, component_context);
    }
}

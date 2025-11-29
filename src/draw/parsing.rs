use crate::draw::geometry::*;
use crate::draw::generation::*;
use crate::draw::tessellation::MIN_VISIBLE_WIDTH_LOD;
use crate::parse_xml::XmlNode;
use indexmap::IndexMap;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

/// Extract all LayerFeatures from XML root and generate LayerJSON for each
pub fn extract_and_generate_layers(root: &XmlNode) -> Result<(Vec<LayerJSON>, Vec<ObjectRange>), anyhow::Error> {
    let total_start = std::time::Instant::now();
    let mut layers_seen = HashSet::new();

    // Parse line descriptors from DictionaryLineDesc
    let parse_start = std::time::Instant::now();
    let line_descriptors = parse_line_descriptors(root);
    let parse_time = parse_start.elapsed();
    
    // Parse standard primitive definitions (circles, rectangles, etc.)
    let primitives = parse_standard_primitives(root);
    
    // Parse padstack definitions (for vias)
    let padstack_defs = parse_padstack_definitions(root);
    
    if std::env::var("PROFILE_TIMING").is_ok() {
        eprintln!("\n=== Detailed Timing Profile ===");
        eprintln!("Line descriptor parsing: {:.2}ms", parse_time.as_secs_f64() * 1000.0);
        eprintln!("Parsed {} standard primitives", primitives.len());
        eprintln!("Parsed {} padstack definitions", padstack_defs.len());
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
    // We need to find the Step node inside CadData
    collect_padstacks_from_step(cad_data, &mut layer_contexts, &primitives);
    
    let collect_time = collect_start.elapsed();

    // 2. Process layers in parallel (Parallel)
    let process_start = std::time::Instant::now();
    
    // Use rayon to process layers in parallel
    // We collect results into a Vec<Result<...>> then collect into Result<Vec<...>>
    let results: Vec<Result<(LayerJSON, Vec<ObjectRange>, CullingStats), anyhow::Error>> = layer_contexts
        .into_iter()
        .collect::<Vec<_>>() // Convert IndexMap to Vec for par_iter
        .into_par_iter()
        .enumerate() // Get index for layer ID generation
        .map(|(idx, (layer_ref, geometries))| {
            let mut local_culling_stats = CullingStats::default();
            
            // Extract layer name from layerRef (e.g., "LAYER:Design" -> "Design")
            let layer_name = layer_ref
                .split(':')
                .next_back()
                .unwrap_or(&layer_ref)
                .to_string();
            
            // Generate default color based on layer type
            let color = get_layer_color(&layer_ref);
            
            let (layer_json, object_ranges) = generate_layer_json(
                &layer_ref,
                idx as u32, // Pass layer index
                &layer_name,
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

    // Print summary if we culled anything
    if total_culling_stats.lod_culled.iter().any(|&c| c > 0) {
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
            // We still track seen layers to avoid re-processing if that was the intent,
            // but using IndexMap allows us to retrieve the entry if we wanted to merge.
            // For now, we keep the logic of "first LayerFeature wins" or "unique layers only"
            // but we use IndexMap to store them.
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
        if let Ok(mut polyline) = parse_polyline_node(node, line_descriptors) {
            polyline.net_name = net_context.map(|s| s.to_string());
            polyline.component_ref = component_context.map(|s| s.to_string());
            geometries.polylines.push(polyline);
        }
    } else if node.name == "Line" {
        if let Ok(mut line_polyline) = parse_line_node(node, line_descriptors) {
            line_polyline.net_name = net_context.map(|s| s.to_string());
            line_polyline.component_ref = component_context.map(|s| s.to_string());
            geometries.polylines.push(line_polyline);
        }
    } else if node.name == "Polygon" {
        // Parse filled polygon shapes
        if let Ok(mut polygon) = parse_polygon_node(node) {
            polygon.net_name = net_context.map(|s| s.to_string());
            polygon.component_ref = component_context.map(|s| s.to_string());
            geometries.polygons.push(polygon);
        }
    } else if node.name == "Contour" {
        // Parse Contour elements (polygon with cutouts for copper pours)
        // Note: We don't recurse into Contour children because we handle them here
        if let Ok(mut polygon) = parse_contour_node(node) {
            polygon.net_name = net_context.map(|s| s.to_string());
            polygon.component_ref = component_context.map(|s| s.to_string());
            geometries.polygons.push(polygon);
        }
        return; // Don't recurse - we've already processed Polygon and Cutout children
    } else if node.name == "LayerFeature" {
        // Collect pads and vias from this layer (they handle their own net context)
        let pads = collect_pads_from_layer(node, padstack_defs);
        geometries.pads.extend(pads);
        
        let vias = collect_vias_from_layer(node, padstack_defs);
        if !vias.is_empty() && std::env::var("PROFILE_TIMING").is_ok() {
            eprintln!("      Collected {} vias", vias.len());
        }
        geometries.vias.extend(vias);
    }

    // Recursively search all children, passing down the net and component context
    for child in &node.children {
        collect_geometries_with_context(child, geometries, line_descriptors, padstack_defs, net_context, component_context);
    }
}

/// Recursively find Step nodes and collect PadStack instances (vias) defined at the Step level
fn collect_padstacks_from_step(
    node: &XmlNode,
    layer_contexts: &mut IndexMap<String, LayerGeometries>,
    primitives: &HashMap<String, StandardPrimitive>,
) {
    if node.name == "Step" {
        // Look for PadStack nodes directly under Step
        for child in &node.children {
            if child.name == "PadStack" {
                // Parse inline PadStack definition
                
                // Get net name from PadStack's net attribute
                let net_name = child.attributes.get("net").map(|s| s.to_string());
                
                // 1. Parse LayerHole (optional, but usually present for vias)
                let mut hole_diameter = 0.0;
                
                for subchild in &child.children {
                    if subchild.name == "LayerHole" {
                        if let Some(diam_str) = subchild.attributes.get("diameter") {
                            if let Ok(d) = diam_str.parse::<f32>() {
                                hole_diameter = d;
                            }
                        }
                    }
                }
                
                // 2. Parse LayerPad elements
                for subchild in &child.children {
                    if subchild.name == "LayerPad" {
                        if let Some(layer_ref) = subchild.attributes.get("layerRef") {
                            // Parse location
                            let mut x = 0.0;
                            let mut y = 0.0;
                            
                            // Find Location node
                            if let Some(loc_node) = subchild.children.iter().find(|n| n.name == "Location") {
                                x = loc_node.attributes.get("x").and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
                                y = loc_node.attributes.get("y").and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
                            }
                            
                            // Find StandardPrimitiveRef
                            if let Some(prim_ref) = subchild.children.iter().find(|n| n.name == "StandardPrimitiveRef") {
                                if let Some(prim_id) = prim_ref.attributes.get("id") {
                                    if let Some(primitive) = primitives.get(prim_id) {
                                        // We need to extract diameter/width from primitive.
                                        let outer_diameter = match primitive {
                                            StandardPrimitive::Circle { diameter } => *diameter,
                                            StandardPrimitive::Rectangle { width, height } => width.max(*height),
                                            StandardPrimitive::Oval { width, height } => width.max(*height),
                                            StandardPrimitive::RoundRect { width, height, .. } => width.max(*height),
                                            StandardPrimitive::CustomPolygon { .. } => 0.0,
                                        };
                                        
                                        let via = ViaInstance {
                                            x,
                                            y,
                                            diameter: outer_diameter,
                                            hole_diameter,
                                            shape: primitive.clone(),
                                            net_name: net_name.clone(),
                                            component_ref: None, // Vias from padstacks don't have component refs
                                        };
                                        
                                        // Add to layer
                                        layer_contexts.entry(layer_ref.clone())
                                            .or_insert_with(|| LayerGeometries {
                                                layer_ref: layer_ref.clone(),
                                                polylines: Vec::new(),
                                                polygons: Vec::new(),
                                                padstack_holes: Vec::new(),
                                                pads: Vec::new(),
                                                vias: Vec::new(),
                                            })
                                            .vias.push(via);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Recurse
    for child in &node.children {
        collect_padstacks_from_step(child, layer_contexts, primitives);
    }
}

/// Extract polylines from a LayerFeatures XML node
#[allow(dead_code)]
fn extract_polylines_from_layer(
    layer_node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Vec<Polyline>, anyhow::Error> {
    let mut polylines = Vec::new();
    
    // Find all Polyline children
    for child in &layer_node.children {
        if child.name == "Polyline" {
            if let Ok(polyline) = parse_polyline_node(child, line_descriptors) {
                polylines.push(polyline);
            }
        }
    }
    
    Ok(polylines)
}

/// Parse a single Polyline XML node
fn parse_polyline_node(
    node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Polyline, anyhow::Error> {
    let mut points = Vec::new();
    let mut width: f32 = node
        .attributes
        .get("width")
        .and_then(|w| w.parse().ok())
        .unwrap_or(0.1);
    let mut line_end = LineEnd::Round;

    // Extract color from attributes or use default
    let color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 1.0]);

    // Look for LineDescRef to get actual width and line end
    let mut line_desc_ref: Option<String> = None;
    
    // Extract points from various child node types
    for child in &node.children {
        match child.name.as_str() {
            // Standard point format
            "Pt" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            // IPC-2581 polyline format: PolyBegin + PolyStepSegment
            "PolyBegin" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            "PolyStepSegment" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            "LineDescRef" => {
                if let Some(id) = child.attributes.get("id") {
                    line_desc_ref = Some(id.clone());
                }
            }
            _ => {}
        }
    }

    // Apply line descriptor if found
    if let Some(ref_id) = line_desc_ref {
        if let Some(descriptor) = line_descriptors.get(&ref_id) {
            width = descriptor.line_width;
            line_end = descriptor.line_end;
        }
    }

    Ok(Polyline {
        points,
        width,
        color,
        line_end,
        net_name: None, // Will be set by caller with net context
        component_ref: None, // Will be set by caller with component context
    })
}

/// Parse a Line XML node by converting it into a two-point polyline
fn parse_line_node(
    node: &XmlNode,
    line_descriptors: &IndexMap<String, LineDescriptor>,
) -> Result<Polyline, anyhow::Error> {
    let start_x = node
        .attributes
        .get("startX")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing startX attribute"))?;
    let start_y = node
        .attributes
        .get("startY")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing startY attribute"))?;
    let end_x = node
        .attributes
        .get("endX")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing endX attribute"))?;
    let end_y = node
        .attributes
        .get("endY")
        .and_then(|v| v.parse::<f32>().ok())
        .ok_or_else(|| anyhow::anyhow!("Line missing endY attribute"))?;

    let mut width: f32 = node
        .attributes
        .get("width")
        .and_then(|w| w.parse().ok())
        .unwrap_or(0.1);
    let mut line_end = LineEnd::Round;

    let color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 1.0]);

    let mut line_desc_ref: Option<String> = None;

    for child in &node.children {
        match child.name.as_str() {
            "LineDescRef" => {
                if let Some(id) = child.attributes.get("id") {
                    line_desc_ref = Some(id.clone());
                }
            }
            "LineDesc" => {
                if let Some(w) = child.attributes.get("lineWidth") {
                    if let Ok(parsed) = w.parse::<f32>() {
                        width = parsed;
                    }
                }
                if let Some(end) = child.attributes.get("lineEnd") {
                    line_end = parse_line_end(end);
                }
            }
            _ => {}
        }
    }

    if let Some(ref_id) = line_desc_ref {
        if let Some(descriptor) = line_descriptors.get(&ref_id) {
            width = descriptor.line_width;
            line_end = descriptor.line_end;
        }
    }

    Ok(Polyline {
        points: vec![
            Point { x: start_x, y: start_y },
            Point { x: end_x, y: end_y },
        ],
        width,
        color,
        line_end,
        net_name: None, // Will be set by caller with net context
        component_ref: None, // Will be set by caller with component context
    })
}

/// Parse line end from string
fn parse_line_end(line_end_str: &str) -> LineEnd {
    match line_end_str.to_uppercase().as_str() {
        "ROUND" => LineEnd::Round,
        "SQUARE" => LineEnd::Square,
        "BUTT" => LineEnd::Butt,
        _ => LineEnd::Round, // Default to round
    }
}

/// Parse a Polygon node (filled shape with optional holes)
/// Expects <Polygon> with PolyBegin/PolyStepSegment children
fn parse_polygon_node(node: &XmlNode) -> Result<Polygon, anyhow::Error> {
    let mut outer_ring: Vec<Point> = Vec::new();
    let mut current_ring: Vec<Point> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    let mut is_first_contour = true;
    
    // Extract fill color from attributes or use default with alpha
    let fill_color = parse_color(&node.attributes).unwrap_or([0.5, 0.5, 0.5, 0.5]);
    
    // Parse polygon contours (outer ring + holes)
    for child in &node.children {
        match child.name.as_str() {
            "PolyBegin" => {
                // Save previous contour if exists
                if !current_ring.is_empty() {
                    if is_first_contour {
                        outer_ring = current_ring.clone();
                        is_first_contour = false;
                    } else {
                        holes.push(current_ring.clone());
                    }
                    current_ring.clear();
                }
                
                // Start new contour
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        current_ring.push(Point { x, y });
                    }
                }
            }
            "PolyStepSegment" | "PolyStepCurve" => {
                // Add point to current contour
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        current_ring.push(Point { x, y });
                    }
                }
            }
            _ => {}
        }
    }
    
    // Save last contour
    if !current_ring.is_empty() {
        if is_first_contour {
            outer_ring = current_ring;
        } else {
            holes.push(current_ring);
        }
    }
    
    if outer_ring.len() < 3 {
        return Err(anyhow::anyhow!("Polygon must have at least 3 points"));
    }
    
    Ok(Polygon {
        outer_ring,
        holes,
        fill_color,
        net_name: None, // Will be set by caller with net context
        component_ref: None, // Will be set by caller with component context
    })
}

/// Parse a Contour node (copper pour with cutouts)
/// Expects <Contour> with <Polygon> (outer boundary) and <Cutout> children (holes)
fn parse_contour_node(node: &XmlNode) -> Result<Polygon, anyhow::Error> {
    let mut outer_ring: Vec<Point> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    
    // Default fill color with alpha
    let fill_color = [0.5, 0.5, 0.5, 0.5];
    
    // Parse the outer Polygon
    if let Some(polygon_node) = node.children.iter().find(|c| c.name == "Polygon") {
        outer_ring = parse_poly_points(polygon_node);
    }
    
    // Parse all Cutout elements as holes
    for child in &node.children {
        if child.name == "Cutout" {
            let hole_ring = parse_poly_points(child);
            if hole_ring.len() >= 3 {
                holes.push(hole_ring);
            }
        }
    }
    
    if outer_ring.len() < 3 {
        return Err(anyhow::anyhow!("Contour must have a Polygon with at least 3 points"));
    }
    
    Ok(Polygon {
        outer_ring,
        holes,
        fill_color,
        net_name: None,
        component_ref: None,
    })
}

/// Helper to parse PolyBegin/PolyStepSegment points from a node
fn parse_poly_points(node: &XmlNode) -> Vec<Point> {
    let mut points = Vec::new();
    
    for child in &node.children {
        match child.name.as_str() {
            "PolyBegin" | "PolyStepSegment" | "PolyStepCurve" => {
                if let (Some(x_str), Some(y_str)) = (
                    child.attributes.get("x"),
                    child.attributes.get("y"),
                ) {
                    if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                        points.push(Point { x, y });
                    }
                }
            }
            _ => {}
        }
    }
    
    points
}

/// Parse pad stack definitions and extract hole + outer diameter information
/// Returns a map of pad stack name -> definition (hole dia + outer dia)
pub fn parse_padstack_definitions(root: &XmlNode) -> IndexMap<String, PadStackDef> {
    let mut padstack_defs = IndexMap::new();
    
    // First, parse user primitive circles to get their diameters AND line widths
    // UserPrimitives can be HOLLOW circles (annular rings) with lineWidth defining ring thickness
    // DictionaryUser is under root -> DictionaryUser or root -> Content -> DictionaryUser or Ecad -> Content -> DictionaryUser
    let mut user_circles: HashMap<String, (f32, f32)> = HashMap::new(); // id -> (diameter, lineWidth)
    
    // Helper to search for DictionaryUser
    fn find_dict_user(node: &XmlNode, circles: &mut HashMap<String, (f32, f32)>) {
        if node.name == "DictionaryUser" {
            for entry in &node.children {
                if entry.name == "EntryUser" {
                    if let Some(id) = entry.attributes.get("id") {
                        for user_special in &entry.children {
                            if user_special.name == "UserSpecial" {
                                for circle in &user_special.children {
                                    if circle.name == "Circle" {
                                        if let Some(dia) = circle.attributes.get("diameter") {
                                            if let Ok(diameter) = dia.parse::<f32>() {
                                                // Look for LineDesc child to get lineWidth (annular ring width)
                                                let mut line_width = 0.0;
                                                for desc in &circle.children {
                                                    if desc.name == "LineDesc" {
                                                        if let Some(lw) = desc.attributes.get("lineWidth") {
                                                            line_width = lw.parse().unwrap_or(0.0);
                                                        }
                                                    }
                                                }
                                                circles.insert(id.clone(), (diameter, line_width));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        for child in &node.children {
            find_dict_user(child, circles);
        }
    }
    
    find_dict_user(root, &mut user_circles);
    
    // Parse standard primitives for shape definitions
    let standard_primitives = parse_standard_primitives(root);
    
    // Now parse PadStackDef entries - search recursively for Step nodes containing PadStackDef
    fn find_padstack_defs(
        node: &XmlNode,
        defs: &mut IndexMap<String, PadStackDef>,
        circles: &HashMap<String, (f32, f32)>,  // id -> (diameter, lineWidth)
        primitives: &HashMap<String, StandardPrimitive>
    ) {
        if node.name == "Step" {
            for child in &node.children {
                if child.name == "PadStackDef" {
                    if let Some(name) = child.attributes.get("name") {
                        let mut hole_diameter = 0.0;
                        let mut outer_diameter = 0.0;
                        let mut shape: Option<StandardPrimitive> = None;
                        
                        // Find PadstackHoleDef
                        for hole_def in &child.children {
                            if hole_def.name == "PadstackHoleDef" {
                                hole_diameter = hole_def
                                    .attributes
                                    .get("diameter")
                                    .and_then(|d| d.parse::<f32>().ok())
                                    .unwrap_or(0.0);
                            }
                            
                            // Find PadstackPadDef to get shape
                            if hole_def.name == "PadstackPadDef" {
                                for pad_child in &hole_def.children {
                                    // Check for UserPrimitiveRef (circles with optional lineWidth for annular rings)
                                    if pad_child.name == "UserPrimitiveRef" {
                                        if let Some(user_id) = pad_child.attributes.get("id") {
                                            if let Some(&(center_dia, line_width)) = circles.get(user_id) {
                                                // If lineWidth > 0, this is a HOLLOW circle (annular ring)
                                                // The diameter is the centerline, lineWidth is the ring thickness
                                                // Outer diameter = center_dia + line_width
                                                // Inner diameter would be center_dia - line_width, but we use hole_diameter instead
                                                if line_width > 0.0 {
                                                    // Annular ring: outer edge is centerline + half lineWidth on each side
                                                    outer_diameter = center_dia + line_width;
                                                } else {
                                                    // Solid circle
                                                    outer_diameter = center_dia;
                                                }
                                                shape = Some(StandardPrimitive::Circle { diameter: outer_diameter });
                                            }
                                        }
                                    }
                                    // Check for StandardPrimitiveRef (all shapes)
                                    else if pad_child.name == "StandardPrimitiveRef" {
                                        if let Some(std_id) = pad_child.attributes.get("id") {
                                            if let Some(prim) = primitives.get(std_id) {
                                                shape = Some(prim.clone());
                                                // Set outer_diameter based on shape type
                                                outer_diameter = match prim {
                                                    StandardPrimitive::Circle { diameter } => *diameter,
                                                    StandardPrimitive::Rectangle { width, height } => width.max(*height),
                                                    StandardPrimitive::Oval { width, height } => width.max(*height),
                                                    StandardPrimitive::RoundRect { width, height, .. } => width.max(*height),
                                                    StandardPrimitive::CustomPolygon { points } => {
                                                        // Find bounding box of polygon
                                                        let mut max_dim = 0.0f32;
                                                        for p in points {
                                                            max_dim = max_dim.max(p.x.abs()).max(p.y.abs());
                                                        }
                                                        max_dim * 2.0
                                                    }
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        if hole_diameter > 0.0 && outer_diameter > 0.0 {
                            if let Some(shape) = shape {
                                defs.insert(
                                    name.clone(),
                                    PadStackDef {
                                        hole_diameter,
                                        outer_diameter,
                                        shape,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
        
        // Recurse into children
        for child in &node.children {
            find_padstack_defs(child, defs, circles, primitives);
        }
    }
    
    find_padstack_defs(root, &mut padstack_defs, &user_circles, &standard_primitives);
    
    padstack_defs
}

/// Parse DictionaryLineDesc to extract line width and end style for each line ID
fn parse_line_descriptors(root: &XmlNode) -> IndexMap<String, LineDescriptor> {
    let mut line_descriptors = IndexMap::new();

    // Find Content node
    if let Some(content_node) = root.children.iter().find(|n| n.name == "Content") {
        // Find DictionaryLineDesc
        if let Some(dict_node) = content_node
            .children
            .iter()
            .find(|n| n.name == "DictionaryLineDesc")
        {
            // Process each EntryLineDesc
            for entry in &dict_node.children {
                if entry.name == "EntryLineDesc" {
                    if let Some(id) = entry.attributes.get("id") {
                        // Find LineDesc child
                        if let Some(line_desc) = entry.children.iter().find(|n| n.name == "LineDesc")
                        {
                            let line_width = line_desc
                                .attributes
                                .get("lineWidth")
                                .and_then(|w| w.parse::<f32>().ok())
                                .unwrap_or(0.1);

                            let line_end = line_desc
                                .attributes
                                .get("lineEnd")
                                .map(|s| parse_line_end(s))
                                .unwrap_or(LineEnd::Round);

                            line_descriptors.insert(
                                id.clone(),
                                LineDescriptor {
                                    line_width,
                                    line_end,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    line_descriptors
}

/// Parse color from attributes
fn parse_color(attrs: &IndexMap<String, String>) -> Option<[f32; 4]> {
    let r = attrs.get("r").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let g = attrs.get("g").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let b = attrs.get("b").and_then(|v| v.parse::<f32>().ok())? / 255.0;
    let a = attrs
        .get("a")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(255.0) / 255.0;
    Some([r, g, b, a])
}

/// Parse StandardPrimitive definitions from DictionaryStandard
fn parse_standard_primitives(root: &XmlNode) -> HashMap<String, StandardPrimitive> {
    let mut primitives = HashMap::new();
    
    // Helper to recursively visit all nodes
    fn visit_nodes(node: &XmlNode, primitives: &mut HashMap<String, StandardPrimitive>) {
        if node.name == "EntryStandard" {
            if let Some(id) = node.attributes.get("id") {
                for child in &node.children {
                    let mut shape = match child.name.as_str() {
                        "Circle" => {
                            let diameter = child.attributes.get("diameter")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Circle { diameter })
                        }
                        "RectCenter" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Rectangle { width, height })
                        }
                        "Oval" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::Oval { width, height })
                        }
                        "RectRound" => {
                            let width = child.attributes.get("width")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let height = child.attributes.get("height")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            let corner_radius = child.attributes.get("radius")
                                .and_then(|v| v.parse::<f32>().ok())
                                .unwrap_or(0.0);
                            Some(StandardPrimitive::RoundRect { width, height, corner_radius })
                        }
                        _ => None,
                    };
                    
                    // If no primitive found, check for <Contour><Polygon> (CUSTOM shapes)
                    if shape.is_none() {
                        if let Some(contour_node) = node.children.iter()
                            .find(|c| c.name == "Contour") {
                            if let Some(polygon_node) = contour_node.children.iter()
                                .find(|c| c.name == "Polygon") {
                                // Parse polygon points from PolyBegin + PolyStepSegment
                                let mut points = Vec::new();
                                for poly_child in &polygon_node.children {
                                    if poly_child.name == "PolyBegin" || poly_child.name == "PolyStepSegment" {
                                        if let (Some(x_str), Some(y_str)) = (poly_child.attributes.get("x"), poly_child.attributes.get("y")) {
                                            if let (Ok(x), Ok(y)) = (x_str.parse::<f32>(), y_str.parse::<f32>()) {
                                                points.push(Point { x, y });
                                            }
                                        }
                                    }
                                }
                                if !points.is_empty() {
                                    shape = Some(StandardPrimitive::CustomPolygon { points });
                                }
                            }
                        }
                    }
                    
                    if let Some(shape) = shape {
                        primitives.insert(id.clone(), shape);
                        break;
                    }
                }
            }
        }
        
        // Recursively visit children
        for child in &node.children {
            visit_nodes(child, primitives);
        }
    }
    
    visit_nodes(root, &mut primitives);
    primitives
}

/// Collect pad instances from LayerFeature nodes
fn collect_pads_from_layer(layer_node: &XmlNode, padstack_defs: &IndexMap<String, PadStackDef>) -> Vec<PadInstance> {
    let mut pads = Vec::new();
    
    // Helper to recursively visit all nodes, tracking net and component context from Set nodes
    fn visit_nodes(node: &XmlNode, pads: &mut Vec<PadInstance>, padstack_defs: &IndexMap<String, PadStackDef>, current_net: Option<&str>, current_component: Option<&str>) {
        // Check if this is a Set with a net attribute or componentRef
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
        
        if node.name == "Pad" {
            // Skip if this is a via (padUsage="VIA")
            if let Some(usage) = node.attributes.get("padUsage") {
                if usage == "VIA" {
                    return; // Don't collect as pad
                }
            }
            
            // Skip if this has a padstackDefRef with an actual hole (PTH - will be rendered as via)
            if let Some(ref_name) = node.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(ref_name) {
                    // Only skip if there's a significant hole (> 0.01mm)
                    if def.hole_diameter > 0.01 {
                        return; // Don't collect as pad, it's a PTH
                    }
                }
            }
            
            let mut x = 0.0;
            let mut y = 0.0;
            let mut rotation = 0.0;
            let mut shape_id = String::new();
            let mut component_ref = component_context.map(|s| s.to_string());
            let mut pin_ref: Option<String> = None;
            
            for child in &node.children {
                match child.name.as_str() {
                    "Location" => {
                        x = child.attributes.get("x")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                        y = child.attributes.get("y")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                    }
                    "Xform" => {
                        rotation = child.attributes.get("rotation")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0.0);
                    }
                    "StandardPrimitiveRef" => {
                        shape_id = child.attributes.get("id")
                            .map(|s| s.clone())
                            .unwrap_or_default();
                    }
                    "PinRef" => {
                        // Get componentRef and pin from PinRef child element
                        if let Some(comp_ref) = child.attributes.get("componentRef") {
                            component_ref = Some(comp_ref.clone());
                        }
                        if let Some(pin) = child.attributes.get("pin") {
                            pin_ref = Some(pin.clone());
                        }
                    }
                    _ => {}
                }
            }
            
            if !shape_id.is_empty() {
                pads.push(PadInstance {
                    shape_id,
                    x,
                    y,
                    rotation,
                    net_name: net_context.map(|s| s.to_string()),
                    component_ref,
                    pin_ref,
                });
            }
        }
        
        // Recursively visit children with net and component context
        for child in &node.children {
            visit_nodes(child, pads, padstack_defs, net_context, component_context);
        }
    }
    
    visit_nodes(layer_node, &mut pads, padstack_defs, None, None);
    pads
}

/// Collect via instances from LayerFeature nodes
/// Also collects plated through holes (PTH) which have actual holes
fn collect_vias_from_layer(layer_node: &XmlNode, padstack_defs: &IndexMap<String, PadStackDef>) -> Vec<ViaInstance> {
    let mut vias = Vec::new();
    
    // Helper to recursively visit all nodes, tracking net and component context from Set nodes
    // Collect both explicit vias (in Set padUsage="VIA") and PTH pads (pads with holes)
    // Both types span multiple layers and should be treated the same for deletion
    fn visit_nodes(node: &XmlNode, vias: &mut Vec<ViaInstance>, padstack_defs: &IndexMap<String, PadStackDef>, parent_is_via_set: bool, current_net: Option<&str>, current_component: Option<&str>) {
        // Check if this is a Set with padUsage="VIA"
        let is_via_set = node.name == "Set" && node.attributes.get("padUsage").map(|s| s.as_str()) == Some("VIA");
        
        // Check if this Set has a net attribute or componentRef
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
        
        if node.name == "Pad" {
            // Collect pads that are either:
            // 1. Inside a Set with padUsage="VIA" (explicit vias)
            // 2. Have a padstack with a hole > 0.01mm (PTH pads - also span multiple layers)
            let in_via_set = parent_is_via_set || is_via_set;
            
            if let Some(ref_name) = node.attributes.get("padstackDefRef") {
                if let Some(def) = padstack_defs.get(ref_name) {
                    // Collect if in via set OR has a significant hole (PTH pad)
                    if in_via_set || def.hole_diameter > 0.01 {
                        let mut x = 0.0;
                        let mut y = 0.0;
                        let mut component_ref = component_context.map(|s| s.to_string());
                        
                        for child in &node.children {
                            match child.name.as_str() {
                                "Location" => {
                                    x = child.attributes.get("x")
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(0.0);
                                    y = child.attributes.get("y")
                                        .and_then(|v| v.parse().ok())
                                        .unwrap_or(0.0);
                                }
                                "PinRef" => {
                                    // Get componentRef from PinRef child element
                                    if let Some(comp_ref) = child.attributes.get("componentRef") {
                                        component_ref = Some(comp_ref.clone());
                                    }
                                }
                                _ => {}
                            }
                        }
                        
                        vias.push(ViaInstance {
                            x,
                            y,
                            diameter: def.outer_diameter,
                            hole_diameter: def.hole_diameter,
                            shape: def.shape.clone(),
                            net_name: net_context.map(|s| s.to_string()),
                            component_ref,
                        });
                    }
                }
            }
        }
        
        // Recursively visit children, passing down via_set status and net/component context
        for child in &node.children {
            visit_nodes(child, vias, padstack_defs, is_via_set || parent_is_via_set, net_context, component_context);
        }
    }
    
    visit_nodes(layer_node, &mut vias, padstack_defs, false, None, None);
    vias
}

/// Get a color for a layer based on its name/type
fn get_layer_color(layer_ref: &str) -> [f32; 4] {
    let lower = layer_ref.to_lowercase();
    
    // Top silkscreen/overlay: pure gray
    if (lower.contains("silkscreen") || lower.contains("silk") || lower.contains("overlay")) && (lower.contains("f.") || lower.contains("top")) {
        return [0.7, 0.7, 0.7, 1.0]; // Gray
    }
    
    // Bottom silkscreen/overlay: yellowish tinted gray
    if (lower.contains("silkscreen") || lower.contains("silk") || lower.contains("overlay")) && (lower.contains("b.") || lower.contains("bottom")) {
        return [0.75, 0.73, 0.6, 1.0]; // Yellowish gray
    }
    
    // Very distinct colors for other layers: top layers red, bottom layers blue
    if lower.contains("f.") || lower.contains("top") {
        // Front/Top layers - reds to oranges
        if lower.contains(".cu") || lower.contains("copper") || lower.contains("layer") || lower.contains("signal") {
            return [1.0, 0.2, 0.2, 1.0]; // Bright red
        } else if lower.contains("paste") {
            return [1.0, 0.5, 0.5, 1.0]; // Light red
        } else if lower.contains("mask") || lower.contains("solder") {
            return [0.8, 0.0, 0.0, 1.0]; // Dark red
        } else {
            return [1.0, 0.3, 0.0, 1.0]; // Orange-red
        }
    } else if lower.contains("b.") || lower.contains("bottom") {
        // Back/Bottom layers - blues to cyans
        if lower.contains(".cu") || lower.contains("copper") || lower.contains("layer") || lower.contains("signal") {
            return [0.2, 0.2, 1.0, 1.0]; // Bright blue
        } else if lower.contains("paste") {
            return [0.5, 0.5, 1.0, 1.0]; // Light blue
        } else if lower.contains("mask") || lower.contains("solder") {
            return [0.0, 0.0, 0.8, 1.0]; // Dark blue
        } else {
            return [0.0, 0.5, 1.0, 1.0]; // Cyan-blue
        }
    }
    
    // Internal layers and other types - greens and purples
    if lower.contains("in") || lower.contains("inner") || lower.contains("ground") || lower.contains("power") || lower.contains("signal") {
        if lower.contains("ground") {
            return [0.2, 0.8, 0.2, 1.0]; // Green for ground
        } else if lower.contains("power") {
            return [0.8, 0.2, 0.8, 1.0]; // Purple for power
        }
        return [0.2, 1.0, 0.2, 1.0]; // Bright green for generic inner/signal
    }
    
    if lower.contains("dielectric") {
        return [0.8, 0.6, 1.0, 1.0]; // Light purple
    }
    
    // Mechanical/Board layers
    if lower.contains("mechanical") || lower.contains("board") || lower.contains("outline") || lower.contains("dimension") {
        return [1.0, 1.0, 0.0, 1.0]; // Yellow
    }
    
    // User layers - distinctive colors
    if lower.contains("user") {
        return [1.0, 0.5, 0.0, 1.0]; // Orange
    }
    
    // Drill/Hole layers
    if lower.contains("drill") || lower.contains("hole") {
        return [0.2, 0.2, 0.2, 1.0]; // Dark gray
    }
    
    [0.7, 0.7, 0.7, 1.0] // default gray
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_line_end() {
        assert_eq!(parse_line_end("ROUND"), LineEnd::Round);
        assert_eq!(parse_line_end("round"), LineEnd::Round);
        assert_eq!(parse_line_end("SQUARE"), LineEnd::Square);
        assert_eq!(parse_line_end("BUTT"), LineEnd::Butt);
        assert_eq!(parse_line_end("unknown"), LineEnd::Round); // Default
    }
}

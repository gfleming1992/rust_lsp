//! File operations: Load, Save, Close

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::lsp::util::get_process_memory_bytes;
use crate::lsp::xml_helpers::{parse_dictionary_colors, update_dictionary_colors, remove_deleted_objects_from_xml, apply_moved_objects_to_xml, parse_dfx_clearance_rule};
use crate::parse_xml::parse_xml_file;
use crate::draw::geometry::SelectableObject;
use crate::draw::parsing::{extract_and_generate_layers, parse_padstack_definitions};
use crate::serialize_xml::xml_node_to_file;
use rstar::RTree;
use serde::Deserialize;
use std::time::Instant;

/// Handle Load request - loads and parses an IPC-2581 XML file
pub fn handle_load(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct LoadParams {
        file_path: String,
    }

    let params: LoadParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {file_path: string}".to_string());
        }
    };

    eprintln!("[LSP Server] Loading file: {}", params.file_path);

    let start_total = Instant::now();

    // Parse XML file
    let start_parse = Instant::now();
    let root = match parse_xml_file(&params.file_path) {
        Ok(doc) => doc,
        Err(e) => {
            return Response::error(id, 1, format!("Failed to parse XML: {}", e));
        }
    };
    eprintln!("[LSP Server] XML Parse time: {:.2?}", start_parse.elapsed());

    // Extract and generate layer geometries
    let start_gen = Instant::now();
    let (layers, mut object_ranges) = match extract_and_generate_layers(&root) {
        Ok((layers, ranges)) => (layers, ranges),
        Err(e) => {
            return Response::error(id, 1, format!("Failed to generate layers: {}", e));
        }
    };
    eprintln!("[LSP Server] Layer Generation (Tessellation) time: {:.2?}", start_gen.elapsed());
    
    // Debug stats
    let objects_with_net = object_ranges.iter().filter(|o| o.net_name.is_some()).count();
    let objects_with_component = object_ranges.iter().filter(|o| o.component_ref.is_some()).count();
    let pads = object_ranges.iter().filter(|o| o.obj_type == 3).count();
    let vias = object_ranges.iter().filter(|o| o.obj_type == 2).count();
    eprintln!("[LSP Server] Object stats: {} total, {} pads, {} vias, {} with net, {} with component",
        object_ranges.len(), pads, vias, objects_with_net, objects_with_component);
    
    // Calculate component polar coordinates for rotation support
    use crate::draw::geometry::calculate_component_polar_coords;
    calculate_component_polar_coords(&mut object_ranges);
    
    // Keep a copy of object_ranges for DRC
    let all_object_ranges = object_ranges.clone();
    
    // Build spatial index
    let start_index = Instant::now();
    let selectable_objects: Vec<SelectableObject> = object_ranges.into_iter()
        .map(SelectableObject::new)
        .collect();
    let spatial_index = RTree::bulk_load(selectable_objects);
    eprintln!("[LSP Server] Spatial Index build time: {:.2?}", start_index.elapsed());
    
    // Parse padstack definitions
    let padstack_defs = parse_padstack_definitions(&root);
    eprintln!("[LSP Server] Parsed {} padstack definitions", padstack_defs.len());
    
    eprintln!("[LSP Server] Total Load time: {:.2?}", start_total.elapsed());
    eprintln!("[LSP Server] Generated {} layers", layers.len());

    // Parse DictionaryColor from XML
    let layer_colors = parse_dictionary_colors(&root);
    eprintln!("[LSP Server] Parsed {} layer colors from DictionaryColor", layer_colors.len());

    // Parse DFM design rules from Dfx elements
    if let Some(clearance_mm) = parse_dfx_clearance_rule(&root) {
        state.design_rules.conductor_clearance_mm = clearance_mm;
        eprintln!("[LSP Server] Using DFM clearance from file: {:.4}mm", clearance_mm);
    } else {
        eprintln!("[LSP Server] No DFM clearance rule found, using default: {:.4}mm", 
            state.design_rules.conductor_clearance_mm);
    }

    // Apply colors to layers
    let mut layers = layers;
    for layer in &mut layers {
        let color_key = format!("LAYER_COLOR_{}", layer.layer_id);
        if let Some(&color) = layer_colors.get(&color_key) {
            layer.default_color = color;
        } else if let Some(&color) = layer_colors.get(&layer.layer_id) {
            layer.default_color = color;
        }
    }

    // Update state
    state.xml_file_path = Some(params.file_path.clone());
    state.xml_root = None; // Don't store to save memory
    state.layers = layers;
    state.layer_colors = layer_colors;
    state.spatial_index = Some(spatial_index);
    state.padstack_defs = padstack_defs;
    state.all_object_ranges = all_object_ranges;
    state.drc_violations.clear();
    state.drc_regions.clear();
    state.deleted_objects.clear();
    state.moved_objects.clear();
    state.modified_regions.clear();

    eprintln!("[LSP Server] File loaded successfully (xml_root dropped to save memory)");

    Response::success(id, serde_json::json!({
        "status": "ok",
        "file_path": params.file_path
    }))
}

/// Handle Save request - serializes XML with modifications to disk
pub fn handle_save(
    state: &mut ServerState,
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
) -> Response {
    #[derive(Deserialize)]
    struct SaveParams {
        #[serde(default)]
        file_path: Option<String>,
    }

    let params: SaveParams = params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or(SaveParams { file_path: None });

    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    let original_path = state.xml_file_path.as_ref().unwrap();
    
    // Generate output path
    let output_path = params.file_path.unwrap_or_else(|| {
        let path = std::path::Path::new(original_path);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("xml");
        let parent = path.parent().unwrap_or(std::path::Path::new("."));
        parent.join(format!("{}_serialized.{}", stem, ext))
            .to_string_lossy()
            .to_string()
    });

    eprintln!("[LSP Server] Saving file to: {}", output_path);
    eprintln!("[LSP Server] Deleted objects count: {}", state.deleted_objects.len());
    eprintln!("[LSP Server] Moved objects count: {}", state.moved_objects.len());
    
    for (obj_id, range) in &state.deleted_objects {
        eprintln!("[LSP Server]   Deleted: id={}, layer={}, type={}", obj_id, range.layer_id, range.obj_type);
    }
    
    for (obj_id, mov) in &state.moved_objects {
        eprintln!("[LSP Server]   Moved: id={}, delta=({:.3}, {:.3})", obj_id, mov.delta_x, mov.delta_y);
    }

    // Re-parse the original XML file
    let start_parse = std::time::Instant::now();
    let mut root = match parse_xml_file(original_path) {
        Ok(r) => r,
        Err(e) => {
            return Response::error(id, error_codes::PARSE_FAILED, 
                format!("Failed to re-parse XML for save: {}", e));
        }
    };
    eprintln!("[LSP Server] Re-parsed XML in {:.2?}", start_parse.elapsed());
    
    // Update colors if modified
    if !state.modified_colors.is_empty() {
        update_dictionary_colors(&mut root, &state.modified_colors);
        eprintln!("[LSP Server] Updated {} modified colors", state.modified_colors.len());
    }
    
    // Apply moved objects
    if !state.moved_objects.is_empty() {
        let moved_count = apply_moved_objects_to_xml(
            &mut root, &state.moved_objects, &state.all_object_ranges, &state.padstack_defs);
        eprintln!("[LSP Server] Applied moves to {} objects in XML", moved_count);
    }
    
    // Remove deleted objects
    if !state.deleted_objects.is_empty() {
        let removed_count = remove_deleted_objects_from_xml(
            &mut root, &state.deleted_objects, &state.layers, &state.padstack_defs);
        eprintln!("[LSP Server] Removed {} objects from XML", removed_count);
    }

    // Serialize to file
    match xml_node_to_file(&root, &output_path) {
        Ok(_) => {
            let deleted_count = state.deleted_objects.len();
            let moved_count = state.moved_objects.len();
            eprintln!("[LSP Server] File saved successfully");
            Response::success(id, serde_json::json!({
                "status": "ok",
                "file_path": output_path,
                "deleted_objects_count": deleted_count,
                "moved_objects_count": moved_count
            }))
        }
        Err(e) => {
            Response::error(id, error_codes::SAVE_FAILED, 
                format!("Failed to save file: {}", e))
        }
    }
}

/// Handle Close request - clears all state to free memory
pub fn handle_close(state: &mut ServerState, id: Option<serde_json::Value>) -> Response {
    let old_memory = get_process_memory_bytes().unwrap_or(0);
    
    // Clear all state
    state.xml_file_path = None;
    state.xml_root = None;
    state.layers.clear();
    state.layer_colors.clear();
    state.modified_colors.clear();
    state.spatial_index = None;
    state.padstack_defs.clear();
    state.deleted_objects.clear();
    state.moved_objects.clear();
    state.hidden_layers.clear();
    state.all_object_ranges.clear();
    state.drc_violations.clear();
    state.drc_regions.clear();
    state.modified_regions.clear();
    
    // Shrink capacity
    state.layers.shrink_to_fit();
    state.layer_colors.shrink_to_fit();
    state.modified_colors.shrink_to_fit();
    state.padstack_defs.shrink_to_fit();
    state.deleted_objects.shrink_to_fit();
    state.moved_objects.shrink_to_fit();
    state.all_object_ranges.shrink_to_fit();
    state.drc_violations.shrink_to_fit();
    state.drc_regions.shrink_to_fit();
    
    let new_memory = get_process_memory_bytes().unwrap_or(0);
    eprintln!("[LSP Server] Close: freed {} MB", 
        (old_memory as i64 - new_memory as i64) / 1024 / 1024);
    
    Response::success(id, serde_json::json!({
        "freed_bytes": old_memory.saturating_sub(new_memory)
    }))
}

//! Highlight handlers: HighlightSelectedNets, HighlightSelectedComponents

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::lsp::util::log_to_file;
use crate::draw::geometry::ObjectRange;
use serde::Deserialize;
use std::collections::HashSet;

/// Handle HighlightSelectedNets request - finds all shapes with matching net names
pub fn handle_highlight_selected_nets(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct HighlightNetsParams {
        object_ids: Vec<u64>,
    }

    let params: HighlightNetsParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {object_ids: number[]}".to_string());
        }
    };

    eprintln!("[LSP Server] HighlightSelectedNets: {} object IDs provided", params.object_ids.len());
    log_to_file(&format!("HighlightSelectedNets: {} object IDs provided: {:?}", 
        params.object_ids.len(), params.object_ids));

    if let Some(tree) = &state.spatial_index {
        let mut net_names: HashSet<String> = HashSet::new();
        let mut no_net_objects: Vec<(u64, [f32; 4])> = Vec::new();
        
        // Collect net names from selected objects
        for obj in tree.iter() {
            if params.object_ids.contains(&obj.range.id) {
                log_to_file(&format!("  Selected object id={}, type={}, net={:?}, component={:?}", 
                    obj.range.id, obj.range.obj_type, obj.range.net_name, obj.range.component_ref));
                if let Some(ref net_name) = obj.range.net_name {
                    if !net_name.is_empty() && net_name != "No Net" {
                        net_names.insert(net_name.clone());
                    } else {
                        no_net_objects.push((obj.range.id, obj.range.bounds));
                    }
                } else {
                    no_net_objects.push((obj.range.id, obj.range.bounds));
                }
            }
        }
        
        let mut include_original_ids: HashSet<u64> = HashSet::new();
        
        // For objects without nets, search for overlapping objects that DO have nets
        if !no_net_objects.is_empty() && net_names.is_empty() {
            log_to_file(&format!("  No nets found in selection, searching {} bounds", no_net_objects.len()));
            let tolerance = 0.01;
            
            for (orig_id, bounds) in &no_net_objects {
                let center_x = (bounds[0] + bounds[2]) / 2.0;
                let center_y = (bounds[1] + bounds[3]) / 2.0;
                let point = [center_x, center_y];
                let obj_width = bounds[2] - bounds[0];
                let obj_height = bounds[3] - bounds[1];
                
                for obj in tree.locate_all_at_point(&point) {
                    if let Some(ref net_name) = obj.range.net_name {
                        if !net_name.is_empty() && net_name != "No Net" {
                            let other_bounds = obj.range.bounds;
                            let other_width = other_bounds[2] - other_bounds[0];
                            let other_height = other_bounds[3] - other_bounds[1];
                            
                            let width_match = (obj_width - other_width).abs() < tolerance;
                            let height_match = (obj_height - other_height).abs() < tolerance;
                            let x_match = (bounds[0] - other_bounds[0]).abs() < tolerance 
                                && (bounds[2] - other_bounds[2]).abs() < tolerance;
                            let y_match = (bounds[1] - other_bounds[1]).abs() < tolerance 
                                && (bounds[3] - other_bounds[3]).abs() < tolerance;
                            
                            if width_match && height_match && x_match && y_match {
                                net_names.insert(net_name.clone());
                                include_original_ids.insert(*orig_id);
                            }
                        }
                    }
                }
            }
        }
        
        log_to_file(&format!("Found {} unique net names: {:?}", net_names.len(), net_names));
        
        if net_names.is_empty() {
            return Response::success(id, serde_json::json!({
                "net_names": [],
                "objects": []
            }));
        }
        
        // Find all objects with matching net names
        let mut matching_objects: Vec<ObjectRange> = tree.iter()
            .filter(|obj| {
                if let Some(ref net_name) = obj.range.net_name {
                    if net_names.contains(net_name) {
                        return true;
                    }
                }
                include_original_ids.contains(&obj.range.id)
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        // Find stacked layer objects (mask/paste/silkscreen or PTH pads on other layers)
        // For vias and pads that span multiple layers, we want to highlight all instances
        let tolerance = 0.01;
        let mut stacked_layer_ids: HashSet<u64> = HashSet::new();
        
        // Collect bounds from both pads (obj_type == 3) and vias/PTH (obj_type == 2)
        // PTH pads are stored as vias since they have holes
        let pad_and_via_bounds: Vec<[f32; 4]> = matching_objects.iter()
            .filter(|obj| obj.obj_type == 2 || obj.obj_type == 3)
            .map(|obj| obj.bounds)
            .collect();
        
        for bounds in &pad_and_via_bounds {
            let center_x = (bounds[0] + bounds[2]) / 2.0;
            let center_y = (bounds[1] + bounds[3]) / 2.0;
            let point = [center_x, center_y];
            let obj_width = bounds[2] - bounds[0];
            let obj_height = bounds[3] - bounds[1];
            
            for obj in tree.locate_all_at_point(&point) {
                if matching_objects.iter().any(|o| o.id == obj.range.id) {
                    continue;
                }
                
                let other_bounds = obj.range.bounds;
                let other_width = other_bounds[2] - other_bounds[0];
                let other_height = other_bounds[3] - other_bounds[1];
                
                let width_match = (obj_width - other_width).abs() < tolerance;
                let height_match = (obj_height - other_height).abs() < tolerance;
                let x_match = (bounds[0] - other_bounds[0]).abs() < tolerance 
                    && (bounds[2] - other_bounds[2]).abs() < tolerance;
                let y_match = (bounds[1] - other_bounds[1]).abs() < tolerance 
                    && (bounds[3] - other_bounds[3]).abs() < tolerance;
                
                if width_match && height_match && x_match && y_match {
                    stacked_layer_ids.insert(obj.range.id);
                }
            }
        }
        
        // Add stacked layer objects
        if !stacked_layer_ids.is_empty() {
            log_to_file(&format!("Found {} additional stacked layer objects", stacked_layer_ids.len()));
            for obj in tree.iter() {
                if stacked_layer_ids.contains(&obj.range.id) {
                    matching_objects.push(obj.range.clone());
                }
            }
        }
        
        let net_names_vec: Vec<String> = net_names.into_iter().collect();
        
        Response::success(id, serde_json::json!({
            "net_names": net_names_vec,
            "objects": matching_objects
        }))
    } else {
        Response::success(id, serde_json::json!({
            "net_names": [],
            "objects": []
        }))
    }
}

/// Handle HighlightSelectedComponents request - finds all shapes with matching component refs
pub fn handle_highlight_selected_components(
    state: &ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct HighlightComponentsParams {
        object_ids: Vec<u64>,
    }

    let params: HighlightComponentsParams = match params.and_then(|p| serde_json::from_value(p).ok()) {
        Some(p) => p,
        None => {
            return Response::error(id, error_codes::INVALID_PARAMS, 
                "Invalid params: expected {object_ids: number[]}".to_string());
        }
    };

    eprintln!("[LSP Server] HighlightSelectedComponents: {} object IDs provided", params.object_ids.len());

    if let Some(tree) = &state.spatial_index {
        let mut component_refs: HashSet<String> = HashSet::new();
        
        for obj in tree.iter() {
            if params.object_ids.contains(&obj.range.id) {
                eprintln!("[LSP Server] Selected object id={}, type={}, net={:?}, component={:?}", 
                    obj.range.id, obj.range.obj_type, obj.range.net_name, obj.range.component_ref);
                if let Some(ref comp_ref) = obj.range.component_ref {
                    if !comp_ref.is_empty() {
                        component_refs.insert(comp_ref.clone());
                    }
                }
            }
        }
        
        eprintln!("[LSP Server] Found {} unique component refs: {:?}", component_refs.len(), component_refs);
        
        if component_refs.is_empty() {
            return Response::success(id, serde_json::json!({
                "component_refs": [],
                "objects": []
            }));
        }
        
        let matching_objects: Vec<ObjectRange> = tree.iter()
            .filter(|obj| {
                if let Some(ref comp_ref) = obj.range.component_ref {
                    component_refs.contains(comp_ref)
                } else {
                    false
                }
            })
            .map(|obj| obj.range.clone())
            .collect();
        
        eprintln!("[LSP Server] Found {} objects with matching components", matching_objects.len());
        
        let component_refs_vec: Vec<String> = component_refs.into_iter().collect();
        
        Response::success(id, serde_json::json!({
            "component_refs": component_refs_vec,
            "objects": matching_objects
        }))
    } else {
        Response::success(id, serde_json::json!({
            "component_refs": [],
            "objects": []
        }))
    }
}

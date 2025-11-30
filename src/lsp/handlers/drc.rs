//! DRC handlers: RunDRC, GetDRCViolations, RunDRCWithRegions, GetDRCRegions

use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::{ServerState, DrcAsyncResult};
use crate::draw::drc::{
    DesignRules, ModifiedRegionInfo,
    run_full_drc, run_full_drc_with_regions, run_incremental_drc_with_regions,
};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Instant;

/// Handle RunDRC request - runs Design Rule Check on all copper layers
pub fn handle_run_drc(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>
) -> Response {
    #[derive(Deserialize)]
    struct RunDRCParams {
        #[serde(default)]
        clearance_mm: Option<f32>,
    }

    let params: RunDRCParams = params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or(RunDRCParams { clearance_mm: None });

    if !state.is_file_loaded() {
        return Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
    }

    if let Some(clearance) = params.clearance_mm {
        state.design_rules.conductor_clearance_mm = clearance;
    }

    eprintln!("[LSP Server] Running DRC with clearance: {:.3}mm", 
        state.design_rules.conductor_clearance_mm);
    
    let start = Instant::now();
    
    let violations = if let Some(ref spatial_index) = state.spatial_index {
        run_full_drc(&state.layers, spatial_index, &state.design_rules)
    } else {
        vec![]
    };
    
    let elapsed = start.elapsed();
    let violation_count = violations.len();
    
    eprintln!("[LSP Server] DRC completed in {:.2}ms: {} violations found", 
        elapsed.as_secs_f64() * 1000.0, violation_count);
    
    state.drc_violations = violations;

    Response::success(id, serde_json::json!({
        "status": "ok",
        "violation_count": violation_count,
        "elapsed_ms": elapsed.as_secs_f64() * 1000.0
    }))
}

/// Handle GetDRCViolations request - returns cached DRC violations
pub fn handle_get_drc_violations(
    state: &ServerState, 
    id: Option<serde_json::Value>
) -> Response {
    Response::success(id, serde_json::to_value(&state.drc_violations).unwrap())
}

/// Handle RunDRCWithRegions request asynchronously
pub fn handle_run_drc_with_regions_async(
    state: &mut ServerState, 
    id: Option<serde_json::Value>, 
    params: Option<serde_json::Value>,
    tx: Option<Sender<DrcAsyncResult>>
) -> String {
    #[derive(Deserialize)]
    struct RunDRCParams {
        #[serde(default)]
        clearance_mm: Option<f32>,
        #[serde(default)]
        force_full: bool,
    }

    let params: RunDRCParams = params
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or(RunDRCParams { clearance_mm: None, force_full: false });

    if !state.is_file_loaded() {
        let response = Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string());
        return serde_json::to_string(&response).unwrap();
    }

    let tx = match tx {
        Some(tx) => tx,
        None => {
            let response = Response::error(id, 3, "DRC channel not available".to_string());
            return serde_json::to_string(&response).unwrap();
        }
    };

    let clearance = params.clearance_mm.unwrap_or(state.design_rules.conductor_clearance_mm);
    
    // Clone data for background thread
    let layers = state.layers.clone();
    let spatial_index = state.spatial_index.clone();
    let design_rules = DesignRules { conductor_clearance_mm: clearance };
    
    let deleted_ids: HashSet<u64> = state.deleted_objects.keys().copied().collect();
    
    // Check for incremental DRC
    let modified_regions: Vec<ModifiedRegionInfo> = state.modified_regions
        .iter()
        .map(|r| ModifiedRegionInfo {
            bounds: r.bounds,
            layer_id: r.layer_id.clone(),
            object_id: r.object_id,
        })
        .collect();
    
    let use_incremental = !params.force_full 
        && !modified_regions.is_empty() 
        && !state.drc_regions.is_empty();
    let existing_regions = if use_incremental { state.drc_regions.clone() } else { vec![] };
    
    state.clear_modified_regions();

    if use_incremental {
        eprintln!("[LSP Server] Starting INCREMENTAL DRC: {:.3}mm ({} modified regions, {} deleted)", 
            clearance, modified_regions.len(), deleted_ids.len());
    } else {
        eprintln!("[LSP Server] Starting FULL DRC: {:.3}mm ({} deleted excluded)", 
            clearance, deleted_ids.len());
    }
    
    // Spawn DRC in background
    thread::spawn(move || {
        let start = Instant::now();
        
        let regions = if let Some(ref index) = spatial_index {
            if use_incremental {
                run_incremental_drc_with_regions(
                    &layers, index, &design_rules, &deleted_ids, 
                    &modified_regions, &existing_regions
                )
            } else {
                run_full_drc_with_regions(&layers, index, &design_rules, &deleted_ids)
            }
        } else {
            vec![]
        };
        
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let _ = tx.send(DrcAsyncResult { regions, elapsed_ms });
    });

    let response = Response::success(id, serde_json::json!({
        "status": "started",
        "message": if use_incremental { 
            "Incremental DRC running in background" 
        } else { 
            "Full DRC running in background" 
        }
    }));
    serde_json::to_string(&response).unwrap()
}

/// Handle GetDRCRegions request - returns cached DRC regions
pub fn handle_get_drc_regions(
    state: &ServerState, 
    id: Option<serde_json::Value>
) -> Response {
    Response::success(id, serde_json::to_value(&state.drc_regions).unwrap())
}

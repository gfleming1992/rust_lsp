//! IPC-2581 Language Server Protocol (LSP) server binary.
//!
//! This is a JSON-RPC based server for viewing and editing IPC-2581 files.
//! It communicates over stdio, receiving requests and sending responses.

use rust_extension::lsp::{Request, Response, ServerState, DrcAsyncResult, error_codes};
use rust_extension::lsp::handlers;
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};

fn main() {
    eprintln!("[LSP Server] Starting IPC-2581 LSP server...");
    let mut state = ServerState::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    
    // Channel for async DRC results
    let (drc_tx, drc_rx): (Sender<DrcAsyncResult>, Receiver<DrcAsyncResult>) = mpsc::channel();
    let mut drc_sender: Option<Sender<DrcAsyncResult>> = Some(drc_tx);

    for line in stdin.lock().lines() {
        // Check for completed DRC results (non-blocking)
        match drc_rx.try_recv() {
            Ok(result) => {
                handle_drc_completion(&mut state, &result, &mut stdout);
            }
            Err(TryRecvError::Empty) => {} // No result yet, continue
            Err(TryRecvError::Disconnected) => {
                // Channel closed, recreate it
                let (tx, _rx) = mpsc::channel();
                drc_sender = Some(tx);
            }
        }
        
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[LSP Server] Error reading stdin: {}", e);
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("[LSP Server] Failed to parse request: {}", e);
                continue;
            }
        };

        let response_json = dispatch_request(&mut state, request, drc_sender.clone());

        writeln!(stdout, "{}", response_json).unwrap();
        stdout.flush().unwrap();
    }

    eprintln!("[LSP Server] Shutting down...");
}

/// Handle completion of async DRC and send notification to client
fn handle_drc_completion(state: &mut ServerState, result: &DrcAsyncResult, stdout: &mut io::Stdout) {
    let region_count = result.regions.len();
    let total_triangles: usize = result.regions.iter().map(|r| r.triangle_count).sum();
    
    eprintln!("[LSP Server] Async DRC completed: {} regions, {} triangles in {:.2}ms", 
        region_count, total_triangles, result.elapsed_ms);
    
    // Store regions in state
    state.drc_regions = result.regions.clone();
    
    // Send notification to client
    let notification = serde_json::json!({
        "id": null,
        "method": "drcComplete",
        "result": {
            "status": "ok",
            "region_count": region_count,
            "total_triangles": total_triangles,
            "elapsed_ms": result.elapsed_ms,
            "regions": &state.drc_regions
        }
    });
    writeln!(stdout, "{notification}").unwrap();
    stdout.flush().unwrap();
}

/// Dispatch a request to the appropriate handler
fn dispatch_request(
    state: &mut ServerState, 
    request: Request, 
    drc_sender: Option<Sender<DrcAsyncResult>>
) -> String {
    match request.method.as_str() {
        // File operations
        "Load" => serde_json::to_string(&handlers::handle_load(state, request.id, request.params)).unwrap(),
        "Save" => serde_json::to_string(&handlers::handle_save(state, request.id, request.params)).unwrap(),
        "Close" => serde_json::to_string(&handlers::handle_close(state, request.id)).unwrap(),
        
        // Layer operations
        "GetLayers" => serde_json::to_string(&handlers::handle_get_layers(state, request.id)).unwrap(),
        "UpdateLayerColor" => serde_json::to_string(&handlers::handle_update_layer_color(state, request.id, request.params)).unwrap(),
        "SetLayerVisibility" => serde_json::to_string(&handlers::handle_set_layer_visibility(state, request.id, request.params)).unwrap(),
        
        // Tessellation
        "GetTessellation" => handlers::handle_get_tessellation_json(state, request.id, request.params),
        "GetTessellationBinary" => handlers::handle_get_tessellation_binary(state, request.id, request.params),
        
        // Selection
        "Select" => serde_json::to_string(&handlers::handle_select(state, request.id, request.params)).unwrap(),
        "BoxSelect" => serde_json::to_string(&handlers::handle_box_select(state, request.id, request.params)).unwrap(),
        "CheckPointHitsSelection" => serde_json::to_string(&handlers::handle_check_point_hits_selection(state, request.id, request.params)).unwrap(),
        
        // Highlighting
        "HighlightSelectedNets" => serde_json::to_string(&handlers::handle_highlight_selected_nets(state, request.id, request.params)).unwrap(),
        "HighlightSelectedComponents" => serde_json::to_string(&handlers::handle_highlight_selected_components(state, request.id, request.params)).unwrap(),
        
        // Edit operations
        "Delete" => serde_json::to_string(&handlers::handle_delete(state, request.id, request.params)).unwrap(),
        "Undo" => serde_json::to_string(&handlers::handle_undo(state, request.id, request.params)).unwrap(),
        "Redo" => serde_json::to_string(&handlers::handle_redo(state, request.id, request.params)).unwrap(),
        "MoveObjects" => serde_json::to_string(&handlers::handle_move_objects(state, request.id, request.params)).unwrap(),
        "UndoMove" => serde_json::to_string(&handlers::handle_undo_move(state, request.id, request.params)).unwrap(),
        "RedoMove" => serde_json::to_string(&handlers::handle_redo_move(state, request.id, request.params)).unwrap(),
        
        // DRC operations
        "RunDRC" => serde_json::to_string(&handlers::handle_run_drc(state, request.id, request.params)).unwrap(),
        "GetDRCViolations" => serde_json::to_string(&handlers::handle_get_drc_violations(state, request.id)).unwrap(),
        "RunDRCWithRegions" => handlers::handle_run_drc_with_regions_async(state, request.id, request.params, drc_sender),
        "GetDRCRegions" => serde_json::to_string(&handlers::handle_get_drc_regions(state, request.id)).unwrap(),
        
        // Query operations
        "QueryNetAtPoint" => serde_json::to_string(&handlers::handle_query_net_at_point(state, request.id, request.params)).unwrap(),
        "GetMemory" => serde_json::to_string(&handlers::handle_get_memory(request.id)).unwrap(),
        
        // Unknown method
        _ => {
            let response = Response::error(
                request.id, 
                error_codes::METHOD_NOT_FOUND, 
                format!("Method not found: {}", request.method)
            );
            serde_json::to_string(&response).unwrap()
        },
    }
}

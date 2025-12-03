//! Utility functions for the LSP server

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use serde::de::DeserializeOwned;
use crate::lsp::protocol::{Response, error_codes};
use crate::lsp::state::ServerState;
use crate::draw::geometry::ObjectRange;

#[cfg(windows)]
use std::mem::MaybeUninit;

/// Track if we've already written to the log this session (to truncate on first write)
static LOG_INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Parse JSON-RPC params into a typed struct, returning an error Response on failure
pub fn parse_params<T: DeserializeOwned>(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    expected: &str,
) -> Result<T, Response> {
    params
        .and_then(|p| serde_json::from_value(p).ok())
        .ok_or_else(|| Response::error(id, error_codes::INVALID_PARAMS, 
            format!("Invalid params: expected {}", expected)))
}

/// Check if a file is loaded, returning an error Response if not
pub fn require_file_loaded(
    state: &ServerState,
    id: Option<serde_json::Value>,
) -> Result<(), Response> {
    if state.is_file_loaded() {
        Ok(())
    } else {
        Err(Response::error(id, error_codes::NO_FILE_LOADED, 
            "No file loaded. Call Load first.".to_string()))
    }
}

/// Parse ObjectRange from params, handling both `{object: ...}` wrapper and direct format
pub fn parse_object_param(params: Option<serde_json::Value>) -> Option<ObjectRange> {
    params.and_then(|p| {
        if let serde_json::Value::Object(map) = &p {
            map.get("object").cloned().and_then(|o| serde_json::from_value(o).ok())
        } else {
            serde_json::from_value(p).ok()
        }
    })
}

/// Calculate center point of a bounding box
pub fn bounds_center(bounds: &[f32; 4]) -> (f32, f32) {
    ((bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0)
}

/// Check if two bounding boxes match within tolerance
pub fn bounds_match(b1: &[f32; 4], b2: &[f32; 4], tolerance: f32) -> bool {
    let w1 = b1[2] - b1[0];
    let h1 = b1[3] - b1[1];
    let w2 = b2[2] - b2[0];
    let h2 = b2[3] - b2[1];
    
    let width_match = (w1 - w2).abs() < tolerance;
    let height_match = (h1 - h2).abs() < tolerance;
    let x_match = (b1[0] - b2[0]).abs() < tolerance && (b1[2] - b2[2]).abs() < tolerance;
    let y_match = (b1[1] - b2[1]).abs() < tolerance && (b1[3] - b2[3]).abs() < tolerance;
    
    width_match && height_match && x_match && y_match
}

/// Get current process memory usage on Windows (returns bytes)
#[cfg(windows)]
pub fn get_process_memory_bytes() -> Option<u64> {
    use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use winapi::um::processthreadsapi::GetCurrentProcess;
    
    unsafe {
        let mut pmc: MaybeUninit<PROCESS_MEMORY_COUNTERS> = MaybeUninit::uninit();
        let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        
        if GetProcessMemoryInfo(
            GetCurrentProcess(),
            pmc.as_mut_ptr(),
            cb,
        ) != 0 {
            let pmc = pmc.assume_init();
            Some(pmc.WorkingSetSize as u64)
        } else {
            None
        }
    }
}

/// Fallback for non-Windows platforms
#[cfg(not(windows))]
pub fn get_process_memory_bytes() -> Option<u64> {
    None
}

/// Helper to log to file for debugging (truncates on first write each session)
pub fn log_to_file(msg: &str) {
    let log_path = if cfg!(windows) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("logs").join("lsp_debug.txt")
    } else {
        std::path::PathBuf::from("logs/lsp_debug.txt")
    };
    
    let is_first_write = !LOG_INITIALIZED.swap(true, Ordering::SeqCst);
    
    let file_result = if is_first_write {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
    } else {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
    };
    
    if let Ok(mut file) = file_result {
        let _ = writeln!(file, "{}", msg);
    }
}

/// Check if a point is inside a triangle using barycentric coordinates
#[allow(clippy::too_many_arguments)]
pub fn point_in_triangle(
    px: f32, py: f32, 
    x0: f32, y0: f32, 
    x1: f32, y1: f32, 
    x2: f32, y2: f32
) -> bool {
    let area = 0.5 * (-y1 * x2 + y0 * (-x1 + x2) + x0 * (y1 - y2) + x1 * y2);
    if area.abs() < 1e-10 {
        return false; // Degenerate triangle
    }
    let s = (y0 * x2 - x0 * y2 + (y2 - y0) * px + (x0 - x2) * py) / (2.0 * area);
    let t = (x0 * y1 - y0 * x1 + (y0 - y1) * px + (x1 - x0) * py) / (2.0 * area);
    s >= 0.0 && t >= 0.0 && (s + t) <= 1.0
}

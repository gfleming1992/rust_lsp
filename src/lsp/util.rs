//! Utility functions for the LSP server

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use std::mem::MaybeUninit;

/// Track if we've already written to the log this session (to truncate on first write)
static LOG_INITIALIZED: AtomicBool = AtomicBool::new(false);

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

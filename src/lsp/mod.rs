//! LSP server module - modular implementation of the IPC-2581 Language Server Protocol
//!
//! This module provides a JSON-RPC based server for viewing and editing IPC-2581 files.
//!
//! # Module Structure
//! - `protocol` - JSON-RPC request/response types
//! - `state` - Server state management
//! - `util` - Utility functions (logging, memory, geometry)
//! - `xml_helpers` - XML DOM manipulation helpers
//! - `handlers` - Request handlers organized by functionality

pub mod handlers;
pub mod protocol;
pub mod state;
pub mod util;
pub mod xml_helpers;

// Re-export key types for convenience
pub use protocol::{Request, Response, TypedResponse, ErrorResponse, error_codes};
pub use state::{ServerState, ModifiedRegion, DrcAsyncResult};

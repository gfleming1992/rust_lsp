//! JSON-RPC protocol types for the LSP server

use serde::{Deserialize, Serialize};

/// JSON-RPC Request format
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: Option<serde_json::Value>,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC Response format
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorResponse>,
}

/// JSON-RPC Error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub code: i32,
    pub message: String,
}

/// Generic typed response for handlers that return structured data
#[derive(Debug, Serialize)]
pub struct TypedResponse<T: Serialize> {
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorResponse>,
}

impl Response {
    /// Create a success response with a JSON value
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    /// Create an error response
    pub fn error(id: Option<serde_json::Value>, code: i32, message: String) -> Self {
        Response {
            id,
            result: None,
            error: Some(ErrorResponse { code, message }),
        }
    }
}

/// Standard JSON-RPC error codes
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    
    // Custom error codes
    pub const NO_FILE_LOADED: i32 = 2;
    pub const LAYER_NOT_FOUND: i32 = 3;
    pub const SAVE_FAILED: i32 = 4;
    pub const PARSE_FAILED: i32 = 5;
}

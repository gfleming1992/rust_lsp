//! LOD (Level of Detail) geometry structures for GPU rendering
//! 
//! This module contains the serializable geometry structures used for
//! transferring geometry data to the WebGPU renderer, including LOD support
//! and base64 encoding for efficient JSON transmission.

use serde::{Serialize, Serializer};
use base64::{Engine as _, engine::general_purpose};
use std::f32::consts::PI;

/// Serialize Vec<f32> as base64-encoded string for compact JSON transmission
pub fn serialize_f32_vec_as_base64<S>(data: &Option<Vec<f32>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match data {
        Some(vec) => {
            let bytes: &[u8] = unsafe {
                std::slice::from_raw_parts(
                    vec.as_ptr() as *const u8,
                    vec.len() * std::mem::size_of::<f32>(),
                )
            };
            let encoded = general_purpose::STANDARD.encode(bytes);
            serializer.serialize_some(&encoded)
        }
        None => serializer.serialize_none(),
    }
}

/// Serialize Vec<f32> as base64-encoded string (non-optional)
pub fn serialize_f32_vec_base64<S>(data: &Vec<f32>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            data.as_ptr() as *const u8,
            data.len() * std::mem::size_of::<f32>(),
        )
    };
    let encoded = general_purpose::STANDARD.encode(bytes);
    serializer.serialize_str(&encoded)
}

/// Serialize Vec<u32> as base64-encoded string for compact JSON transmission
pub fn serialize_u32_vec_as_base64<S>(data: &Option<Vec<u32>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match data {
        Some(vec) => {
            let bytes: &[u8] = unsafe {
                std::slice::from_raw_parts(
                    vec.as_ptr() as *const u8,
                    vec.len() * std::mem::size_of::<u32>(),
                )
            };
            let encoded = general_purpose::STANDARD.encode(bytes);
            serializer.serialize_some(&encoded)
        }
        None => serializer.serialize_none(),
    }
}

/// Helper to pack rotation angle (radians) and visibility into a single f32
/// Format: [16-bit quantized angle][15-bit unused][1-bit visibility]
pub fn pack_rotation_visibility(angle: f32, visible: bool) -> f32 {
    // Normalize angle to 0..1 range
    let angle_normalized = angle.rem_euclid(2.0 * PI) / (2.0 * PI);
    // Quantize to 16 bits (0..65535)
    let angle_u16 = (angle_normalized * 65535.0) as u16;
    
    // Pack: angle in upper 16 bits, visibility in LSB
    let mut packed = (angle_u16 as u32) << 16;
    if visible {
        packed |= 1;
    }
    
    f32::from_bits(packed)
}

/// Serializable geometry LOD for JSON
#[derive(Serialize, Clone)]
pub struct GeometryLOD {
    /// Base64-encoded Float32 vertex data (x, y, x, y, ...)
    #[serde(rename = "vertexData", serialize_with = "serialize_f32_vec_base64")]
    pub vertex_data: Vec<f32>,
    
    /// Number of vertices (not bytes)
    #[serde(rename = "vertexCount")]
    pub vertex_count: usize,
    
    /// Base64-encoded Uint32 indices
    #[serde(rename = "indexData", skip_serializing_if = "Option::is_none", serialize_with = "serialize_u32_vec_as_base64")]
    pub index_data: Option<Vec<u32>>,
    
    /// Optional number of indices
    #[serde(rename = "indexCount")]
    pub index_count: Option<usize>,
    
    /// Base64-encoded per-vertex alpha values (1 float per vertex)
    #[serde(rename = "alphaData", skip_serializing_if = "Option::is_none", serialize_with = "serialize_f32_vec_as_base64")]
    pub alpha_data: Option<Vec<f32>>,

    /// Base64-encoded per-vertex visibility values (1 float per vertex) - for batched geometry
    #[serde(rename = "visibilityData", skip_serializing_if = "Option::is_none", serialize_with = "serialize_f32_vec_as_base64")]
    pub visibility_data: Option<Vec<f32>>,
    
    /// Base64-encoded instance data for instanced rendering (x, y, rotation for instanced_rot; x, y for instanced)
    #[serde(rename = "instanceData", skip_serializing_if = "Option::is_none", serialize_with = "serialize_f32_vec_as_base64")]
    pub instance_data: Option<Vec<f32>>,
    
    /// Optional number of instances
    #[serde(rename = "instanceCount", skip_serializing_if = "Option::is_none")]
    pub instance_count: Option<usize>,
}

/// Culling statistics for optimization reporting
#[derive(Debug, Default)]
pub struct CullingStats {
    pub lod_culled: [usize; 5],
    pub total_polylines: usize,
}

/// Shader geometry organized by type
#[derive(Serialize, Default, Clone)]
pub struct ShaderGeometry {
    /// For batch.wgsl - polylines without alpha (opaque, alpha=1.0 implicit)
    pub batch: Option<Vec<GeometryLOD>>,
    
    /// For batch_colored.wgsl - polygons with per-vertex alpha transparency
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_colored: Option<Vec<GeometryLOD>>,
    
    /// For instanced_rot shader - pads with rotation (x, y, rotation per instance)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instanced_rot: Option<Vec<GeometryLOD>>,
    
    /// For instanced shader - vias without rotation (x, y per instance)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instanced: Option<Vec<GeometryLOD>>,
}

/// Complete layer JSON structure matching main.ts
#[derive(Serialize, Clone)]
pub struct LayerJSON {
    #[serde(rename = "layerId")]
    pub layer_id: String,
    
    #[serde(rename = "layerName")]
    pub layer_name: String,
    
    /// Layer function from IPC-2581 (SIGNAL, CONDUCTOR, PLANE, MIXED, SOLDERMASK, etc.)
    #[serde(rename = "layerFunction")]
    pub layer_function: String,
    
    #[serde(rename = "defaultColor")]
    pub default_color: [f32; 4],
    
    pub geometry: ShaderGeometry,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_geometry_lod_serialization() {
        let data: Vec<f32> = vec![1.0, 2.0, 3.0, 4.0];
        let lod = GeometryLOD {
            vertex_data: data.clone(),
            vertex_count: 2,
            index_data: Some(vec![0, 1, 2]),
            index_count: Some(3),
            alpha_data: None,
            visibility_data: None,
            instance_data: None,
            instance_count: None,
        };
        let json = serde_json::to_string(&lod).unwrap();
        assert!(json.contains("vertexData"));
        assert!(json.contains("vertexCount"));
    }
}

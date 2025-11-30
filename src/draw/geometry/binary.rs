//! Binary serialization for layer geometry data
//! 
//! This module provides zero-copy binary transfer of geometry data,
//! used for efficient IPC between the LSP server and the webview.

use super::lod::ShaderGeometry;

/// Binary layer data structure for zero-copy transfer
pub struct LayerBinary {
    pub layer_id: String,
    pub layer_name: String,
    pub default_color: [f32; 4],
    pub geometry_data: Vec<u8>,
}

impl LayerBinary {
    /// Create binary layer data from LayerJSON
    pub fn from_layer_json(layer: &super::lod::LayerJSON) -> Self {
        let geometry_data = serialize_geometry_binary(&layer.geometry);
        
        LayerBinary {
            layer_id: layer.layer_id.clone(),
            layer_name: layer.layer_name.clone(),
            default_color: layer.default_color,
            geometry_data,
        }
    }
    
    /// Write to binary file format
    /// Format: [header][metadata][geometry_data]
    /// Header: "IPC2581B" (8 bytes magic)
    /// Metadata: layer_id_len(u32) + layer_id + padding + layer_name_len(u32) + layer_name + padding + color(4 x f32)
    /// Padding ensures 4-byte alignment for Float32Array/Uint32Array views
    /// Geometry: custom binary format
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buffer = Vec::new();
        
        // Magic header (8 bytes - already aligned)
        buffer.extend_from_slice(b"IPC2581B");
        
        // Layer ID (length-prefixed string with padding to 4-byte boundary)
        let id_bytes = self.layer_id.as_bytes();
        buffer.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
        buffer.extend_from_slice(id_bytes);
        // Add padding to align to 4-byte boundary
        let id_padding = (4 - (id_bytes.len() % 4)) % 4;
        buffer.resize(buffer.len() + id_padding, 0);
        
        // Layer name (length-prefixed string with padding to 4-byte boundary)
        let name_bytes = self.layer_name.as_bytes();
        buffer.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
        buffer.extend_from_slice(name_bytes);
        // Add padding to align to 4-byte boundary
        let name_padding = (4 - (name_bytes.len() % 4)) % 4;
        buffer.resize(buffer.len() + name_padding, 0);
        
        // Default color (4 x f32 - already 4-byte aligned)
        for &c in &self.default_color {
            buffer.extend_from_slice(&c.to_le_bytes());
        }
        
        // Geometry data (already properly aligned internally)
        buffer.extend_from_slice(&self.geometry_data);
        
        buffer
    }
}

/// Serialize geometry to custom binary format
/// Format: [num_lods: u32][lod0][lod1]...[lodN]
/// Each LOD: [vertex_count: u32][index_count: u32][vertex_data][index_data]
/// vertex_data: raw f32 array (x,y,x,y,...)
/// index_data: raw u32 array
pub fn serialize_geometry_binary(geometry: &ShaderGeometry) -> Vec<u8> {
    let mut buffer = Vec::new();
    
    // Serialize batch geometry (polylines without alpha)
    serialize_batch_lods(&mut buffer, geometry.batch.as_ref());
    
    // Serialize batch_colored geometry (polygons with alpha)
    serialize_batch_colored_lods(&mut buffer, geometry.batch_colored.as_ref());
    
    // Serialize instanced_rot geometry (pads with rotation)
    serialize_instanced_lods(&mut buffer, geometry.instanced_rot.as_ref());
    
    // Serialize instanced geometry (vias without rotation)
    serialize_instanced_lods(&mut buffer, geometry.instanced.as_ref());
    
    buffer
}

/// Serialize batch LODs (polylines without alpha)
fn serialize_batch_lods(buffer: &mut Vec<u8>, lods: Option<&Vec<super::lod::GeometryLOD>>) {
    if let Some(lods) = lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Has visibility flag
            let has_vis = lod.visibility_data.is_some();
            buffer.push(if has_vis { 1 } else { 0 });
            // Padding to maintain 4-byte alignment
            buffer.extend_from_slice(&[0u8, 0u8, 0u8]);

            // Raw vertex data (Float32)
            for &f in &lod.vertex_data {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
            // Raw index data (Uint32)
            if let Some(indices) = &lod.index_data {
                for &idx in indices {
                    buffer.extend_from_slice(&idx.to_le_bytes());
                }
            }
            // Visibility data (Float32) if present
            if let Some(vis_values) = &lod.visibility_data {
                for &v in vis_values {
                    buffer.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    } else {
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
}

/// Serialize batch_colored LODs (polygons with alpha)
fn serialize_batch_colored_lods(buffer: &mut Vec<u8>, lods: Option<&Vec<super::lod::GeometryLOD>>) {
    if let Some(lods) = lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Has alpha flag
            let has_alpha = lod.alpha_data.is_some();
            // Has visibility flag
            let has_vis = lod.visibility_data.is_some();
            
            // Pack flags: bit 0 = alpha, bit 1 = visibility
            let mut flags = 0u8;
            if has_alpha { flags |= 1; }
            if has_vis { flags |= 2; }
            buffer.push(flags);
            
            // Padding to maintain 4-byte alignment
            buffer.extend_from_slice(&[0u8, 0u8, 0u8]);
            
            // Raw vertex data (Float32)
            for &f in &lod.vertex_data {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
            // Raw index data (Uint32)
            if let Some(indices) = &lod.index_data {
                for &idx in indices {
                    buffer.extend_from_slice(&idx.to_le_bytes());
                }
            }
            // Alpha data (Float32) if present
            if let Some(alpha_values) = &lod.alpha_data {
                for &alpha in alpha_values {
                    buffer.extend_from_slice(&alpha.to_le_bytes());
                }
            }
            // Visibility data (Float32) if present
            if let Some(vis_values) = &lod.visibility_data {
                for &v in vis_values {
                    buffer.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    } else {
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
}

/// Serialize instanced LODs (pads with rotation or vias without rotation)
fn serialize_instanced_lods(buffer: &mut Vec<u8>, lods: Option<&Vec<super::lod::GeometryLOD>>) {
    if let Some(lods) = lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Instance count
            let instance_count = lod.instance_count.unwrap_or(0);
            buffer.extend_from_slice(&(instance_count as u32).to_le_bytes());
            
            // Raw vertex data (Float32) - base shape
            for &f in &lod.vertex_data {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
            // Raw index data (Uint32)
            if let Some(indices) = &lod.index_data {
                for &idx in indices {
                    buffer.extend_from_slice(&idx.to_le_bytes());
                }
            }
            // Instance data (Float32) - x, y, [rotation] per instance
            if let Some(instance_data) = &lod.instance_data {
                for &f in instance_data {
                    buffer.extend_from_slice(&f.to_le_bytes());
                }
            }
        }
    } else {
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
}

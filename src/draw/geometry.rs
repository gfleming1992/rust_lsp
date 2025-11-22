use serde::{Serialize, Serializer};
use base64::{Engine as _, engine::general_purpose};

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

/// A 2D point
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Line end style
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum LineEnd {
    #[default]
    Round,
    Square,
    Butt,
}

/// Line descriptor from DictionaryLineDesc
#[derive(Debug, Clone)]
pub struct LineDescriptor {
    pub line_width: f32,
    pub line_end: LineEnd,
}

/// Represents a single polyline
#[derive(Debug, Clone)]
pub struct Polyline {
    pub points: Vec<Point>,
    pub width: f32,
    pub color: [f32; 4],
    pub line_end: LineEnd,
}

/// Represents a filled polygon (with optional holes)
#[derive(Debug, Clone)]
pub struct Polygon {
    pub outer_ring: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
    pub fill_color: [f32; 4],  // Supports alpha for transparency
}

/// Represents a pad stack hole with optional annular ring
#[derive(Debug, Clone)]
pub struct PadStackHole {
    pub x: f32,
    pub y: f32,
    pub hole_diameter: f32,
    pub ring_width: f32,  // 0 means no ring, just hole
}

/// Standard primitive shape definition
#[derive(Debug, Clone, Serialize)]
pub enum StandardPrimitive {
    Circle { diameter: f32 },
    Rectangle { width: f32, height: f32 },
    Oval { width: f32, height: f32 },
    RoundRect { width: f32, height: f32, corner_radius: f32 },
    CustomPolygon { points: Vec<Point> },
}

/// Pad instance with shape reference, position, and rotation
#[derive(Debug, Clone, Serialize)]
pub struct PadInstance {
    pub shape_id: String,
    pub x: f32,
    pub y: f32,
    pub rotation: f32,  // degrees
}

/// Padstack definition (for vias and component pads)
#[derive(Debug, Clone)]
pub struct PadStackDef {
    pub hole_diameter: f32,
    pub outer_diameter: f32,  // From pad definition circle (deprecated for non-circles)
    pub shape: StandardPrimitive,  // Actual pad shape
}

/// Via instance (hole through layers - can be circular, square, etc.)
#[derive(Debug, Clone, Serialize)]
pub struct ViaInstance {
    pub x: f32,
    pub y: f32,
    pub diameter: f32,  // For circles, or max dimension for other shapes
    pub hole_diameter: f32,
    pub shape: StandardPrimitive,
}

/// Represents all geometries organized by layer
#[derive(Debug)]
pub struct LayerGeometries {
    pub layer_ref: String,
    pub polylines: Vec<Polyline>,
    pub polygons: Vec<Polygon>,
    pub padstack_holes: Vec<PadStackHole>,
    pub pads: Vec<PadInstance>,
    pub vias: Vec<ViaInstance>,
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
    
    #[serde(rename = "defaultColor")]
    pub default_color: [f32; 4],
    
    pub geometry: ShaderGeometry,
}

/// Binary layer data structure for zero-copy transfer
pub struct LayerBinary {
    pub layer_id: String,
    pub layer_name: String,
    pub default_color: [f32; 4],
    pub geometry_data: Vec<u8>,
}

impl LayerBinary {
    /// Create binary layer data from LayerJSON
    pub fn from_layer_json(layer: &LayerJSON) -> Self {
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
fn serialize_geometry_binary(geometry: &ShaderGeometry) -> Vec<u8> {
    let mut buffer = Vec::new();
    
    // Serialize batch geometry (polylines without alpha)
    let batch_lods = geometry.batch.as_ref();
    if let Some(lods) = batch_lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
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
        }
    } else {
        // No batch geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    // Serialize batch_colored geometry (polygons with alpha)
    let batch_colored_lods = geometry.batch_colored.as_ref();
    if let Some(lods) = batch_colored_lods {
        buffer.extend_from_slice(&(lods.len() as u32).to_le_bytes());
        for lod in lods {
            // Vertex count
            buffer.extend_from_slice(&(lod.vertex_count as u32).to_le_bytes());
            // Index count
            let index_count = lod.index_count.unwrap_or(0);
            buffer.extend_from_slice(&(index_count as u32).to_le_bytes());
            // Has alpha flag
            let has_alpha = lod.alpha_data.is_some();
            buffer.push(if has_alpha { 1 } else { 0 });
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
        }
    } else {
        // No batch_colored geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    // Serialize instanced_rot geometry (pads with rotation)
    let instanced_rot_lods = geometry.instanced_rot.as_ref();
    if let Some(lods) = instanced_rot_lods {
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
            // Instance data (Float32) - x, y, rotation per instance
            if let Some(instance_data) = &lod.instance_data {
                for &f in instance_data {
                    buffer.extend_from_slice(&f.to_le_bytes());
                }
            }
        }
    } else {
        // No instanced_rot geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    // Serialize instanced geometry (vias without rotation)
    let instanced_lods = geometry.instanced.as_ref();
    if let Some(lods) = instanced_lods {
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
            // Instance data (Float32) - x, y per instance
            if let Some(instance_data) = &lod.instance_data {
                for &f in instance_data {
                    buffer.extend_from_slice(&f.to_le_bytes());
                }
            }
        }
    } else {
        // No instanced geometry
        buffer.extend_from_slice(&0u32.to_le_bytes());
    }
    
    buffer
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
            instance_data: None,
            instance_count: None,
        };
        let json = serde_json::to_string(&lod).unwrap();
        assert!(json.contains("vertexData"));
        assert!(json.contains("vertexCount"));
    }
}

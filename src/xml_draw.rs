/// XML Draw module - Extracts polylines from IPC-2581 XML and generates LOD geometries
///
/// This module handles:
/// 1. Extracting LayerFeatures → Polylines from parsed XML
/// 2. Generating 5-level LODs using Douglas-Peucker simplification
/// 3. Tessellating polylines into vertex/index buffers matching BatchedPolylines.js
/// 4. Serializing to LayerJSON format for WebGPU rendering
///
/// The LOD system:
/// - LOD0: Full detail (original polyline points)
/// - LOD1-4: Progressively simplified using Douglas-Peucker
/// - Tolerance increases ~4x per level (configurable)
/// - Vertex/index data base64-encoded as Float32Array/Uint32Array
// Re-export everything from the new module structure
pub use crate::draw::parsing::extract_and_generate_layers;
pub use crate::draw::geometry::*;
pub use crate::draw::tessellation::*;
pub use crate::draw::generation::*;

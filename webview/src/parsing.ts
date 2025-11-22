import { LayerJSON } from "./types";

/**
 * Parse custom binary layer format
 * Format: [header][metadata][geometry_data]
 * Header: "IPC2581B" (8 bytes magic)
 * Metadata: layer_id_len(u32) + layer_id + padding + layer_name_len(u32) + layer_name + padding + color(4 x f32)
 * Geometry: [num_lods: u32][lod0][lod1]...[lodN]
 * Each LOD: [vertex_count: u32][index_count: u32][vertex_data: f32[]](index_data: u32[])
 */
export function parseBinaryLayer(buffer: ArrayBuffer): LayerJSON {
  const view = new DataView(buffer);
  let offset = 0;
  
  // Check magic header
  const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 8));
  if (magic !== 'IPC2581B') {
    throw new Error(`Invalid binary format: expected "IPC2581B", got "${magic}"`);
  }
  offset += 8;
  
  // Read layer ID
  const idLen = view.getUint32(offset, true);
  offset += 4;
  const layerId = new TextDecoder().decode(new Uint8Array(buffer, offset, idLen));
  offset += idLen;
  // Skip padding to 4-byte boundary
  const idPadding = (4 - (idLen % 4)) % 4;
  offset += idPadding;
  
  // Read layer name
  const nameLen = view.getUint32(offset, true);
  offset += 4;
  const layerName = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLen));
  offset += nameLen;
  // Skip padding to 4-byte boundary
  const namePadding = (4 - (nameLen % 4)) % 4;
  offset += namePadding;
  
  // Read color
  const color = [
    view.getFloat32(offset, true),
    view.getFloat32(offset + 4, true),
    view.getFloat32(offset + 8, true),
    view.getFloat32(offset + 12, true)
  ];
  offset += 16;
  
  // Read geometry data
  
  // Read batch geometry (polylines without alpha)
  const numBatchLods = view.getUint32(offset, true);
  offset += 4;
  
  const batchLods = [];
  for (let i = 0; i < numBatchLods; i++) {
    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = view.getUint32(offset, true);
    offset += 4;
    
    // Zero-copy view into buffer for vertex data
    const vertexData = new Float32Array(buffer, offset, vertexCount * 2);
    offset += vertexCount * 2 * 4; // 2 floats per vertex, 4 bytes per float
    
    // Zero-copy view into buffer for index data
    const indexData = indexCount > 0 ? new Uint32Array(buffer, offset, indexCount) : undefined;
    offset += indexCount * 4;
    
    batchLods.push({
      vertexData,
      vertexCount,
      indexData,
      indexCount
    });
  }
  
  // Read batch_colored geometry (polygons with alpha)
  const numColoredLods = view.getUint32(offset, true);
  offset += 4;
  
  const coloredLods = [];
  for (let i = 0; i < numColoredLods; i++) {
    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = view.getUint32(offset, true);
    offset += 4;
    const hasAlpha = view.getUint8(offset);
    offset += 1;
    // Skip 3 bytes padding
    offset += 3;
    
    // Zero-copy view into buffer for vertex data
    const vertexData = new Float32Array(buffer, offset, vertexCount * 2);
    offset += vertexCount * 2 * 4; // 2 floats per vertex, 4 bytes per float
    
    // Zero-copy view into buffer for index data
    const indexData = indexCount > 0 ? new Uint32Array(buffer, offset, indexCount) : undefined;
    offset += indexCount * 4;
    
    // Read alpha data if present
    let alphaData = undefined;
    if (hasAlpha) {
      const alphaArray = new Float32Array(buffer, offset, vertexCount);
      // Base64 encode the alpha array to match what Rust would send
      const alphaBytes = new Uint8Array(alphaArray.buffer, alphaArray.byteOffset, alphaArray.byteLength);
      const alphaBinary = String.fromCharCode(...alphaBytes);
      alphaData = btoa(alphaBinary);
      offset += vertexCount * 4;
    }
    
    coloredLods.push({
      vertexData,
      vertexCount,
      indexData,
      indexCount,
      alphaData
    });
  }
  
  // Read instanced_rot geometry (pads with rotation)
  const numInstancedRotLods = view.getUint32(offset, true);
  offset += 4;
  
  const instancedRotLods = [];
  for (let i = 0; i < numInstancedRotLods; i++) {
    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = view.getUint32(offset, true);
    offset += 4;
    const instanceCount = view.getUint32(offset, true);
    offset += 4;
    
    // Zero-copy view into buffer for vertex data (base shape)
    const vertexData = new Float32Array(buffer, offset, vertexCount * 2);
    offset += vertexCount * 2 * 4;
    
    // Zero-copy view into buffer for index data
    const indexData = indexCount > 0 ? new Uint32Array(buffer, offset, indexCount) : undefined;
    offset += indexCount * 4;
    
    // Zero-copy view for instance data (x, y, rotation - 3 floats per instance)
    const instanceData = instanceCount > 0 ? new Float32Array(buffer, offset, instanceCount * 3) : undefined;
    offset += instanceCount * 3 * 4;
    
    instancedRotLods.push({
      vertexData,
      vertexCount,
      indexData,
      indexCount,
      instanceData,
      instanceCount
    });
  }
  
  // Read instanced geometry (vias without rotation)
  const numInstancedLods = view.getUint32(offset, true);
  offset += 4;
  
  const instancedLods = [];
  for (let i = 0; i < numInstancedLods; i++) {
    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = view.getUint32(offset, true);
    offset += 4;
    const instanceCount = view.getUint32(offset, true);
    offset += 4;
    
    // Zero-copy view into buffer for vertex data (base shape)
    const vertexData = new Float32Array(buffer, offset, vertexCount * 2);
    offset += vertexCount * 2 * 4;
    
    // Zero-copy view into buffer for index data
    const indexData = indexCount > 0 ? new Uint32Array(buffer, offset, indexCount) : undefined;
    offset += indexCount * 4;
    
    // Zero-copy view for instance data (x, y - 2 floats per instance)
    const instanceData = instanceCount > 0 ? new Float32Array(buffer, offset, instanceCount * 2) : undefined;
    offset += instanceCount * 2 * 4;
    
    instancedLods.push({
      vertexData,
      vertexCount,
      indexData,
      indexCount,
      instanceData,
      instanceCount
    });
  }
  
  return {
    layerId,
    layerName,
    defaultColor: color as any, // Cast to avoid tuple issues
    geometry: {
      batch: batchLods.length > 0 ? batchLods : undefined,
      batch_colored: coloredLods.length > 0 ? coloredLods : undefined,
      instanced_rot: instancedRotLods.length > 0 ? instancedRotLods : undefined,
      instanced: instancedLods.length > 0 ? instancedLods : undefined
    }
  };
}

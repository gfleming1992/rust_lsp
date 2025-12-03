import { LayerJSON, ShaderGeometry, GeometryLOD } from "../types";

/**
 * Parse binary layer data from the LayerBinary format
 * Format: [header][metadata][geometry_data]
 * Header: "IPC2581B" (8 bytes magic)
 * Metadata: layer_id_len(u32) + layer_id + padding + layer_name_len(u32) + layer_name + padding + color(4 x f32)
 * Geometry: custom binary format (see parseGeometryBinary)
 */
export function parseBinaryLayer(buffer: ArrayBuffer): LayerJSON {
  const view = new DataView(buffer);
  let offset = 0;

  // Read and verify magic header (8 bytes)
  const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 8));
  if (magic !== "IPC2581B") {
    throw new Error(`Invalid binary format: expected magic "IPC2581B", got "${magic}"`);
  }
  offset += 8;

  // Read layer_id (length-prefixed string with padding)
  const idLength = view.getUint32(offset, true); // little-endian
  offset += 4;
  const layerId = new TextDecoder().decode(new Uint8Array(buffer, offset, idLength));
  offset += idLength;
  // Skip padding to 4-byte boundary
  const idPadding = (4 - (idLength % 4)) % 4;
  offset += idPadding;

  // Read layer_name (length-prefixed string with padding)
  const nameLength = view.getUint32(offset, true);
  offset += 4;
  const layerName = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLength));
  offset += nameLength;
  // Skip padding to 4-byte boundary
  const namePadding = (4 - (nameLength % 4)) % 4;
  offset += namePadding;

  // Read default_color (4 x f32)
  const defaultColor: [number, number, number, number] = [
    view.getFloat32(offset, true),
    view.getFloat32(offset + 4, true),
    view.getFloat32(offset + 8, true),
    view.getFloat32(offset + 12, true),
  ];
  offset += 16;

  // Parse geometry data
  const geometry = parseGeometryBinary(buffer, offset);

  return {
    layerId,
    layerName,
    defaultColor: defaultColor,
    geometry,
  };
}

/**
 * Parse geometry from binary format
 * Format: [num_batch_lods: u32][batch_lod0][batch_lod1]...[num_batch_colored_lods: u32][...]
 * Each LOD: [vertex_count: u32][index_count: u32][vertex_data][index_data]
 */
function parseGeometryBinary(buffer: ArrayBuffer, startOffset: number): ShaderGeometry {
  const view = new DataView(buffer);
  let offset = startOffset;

  const geometry: ShaderGeometry = {};

  // Parse batch geometry (polylines without alpha)
  const numBatchLods = view.getUint32(offset, true);
  offset += 4;

  if (numBatchLods > 0 && numBatchLods < 100) {
    const batchLods: GeometryLOD[] = [];
    for (let i = 0; i < numBatchLods; i++) {
      const vertexCount = view.getUint32(offset, true);
      offset += 4;
      const indexCount = view.getUint32(offset, true);
      offset += 4;
      
      if (vertexCount > 50000000) {
        throw new Error(`[BinaryParser] Sanity check failed: batch vertexCount ${vertexCount} is too large at offset ${offset - 8}`);
      }
      
      // Read visibility flag
      const hasVisibility = view.getUint8(offset) === 1;
      offset += 1;
      // Skip padding (3 bytes)
      offset += 3;

      // Read vertex_data as Float32Array (zero-copy view)
      const numFloats = vertexCount * 2;
      const vertexData = new Float32Array(buffer, offset, numFloats);
      offset += numFloats * 4;

      // Read index_data as Uint32Array (zero-copy view) if present
      let indexData: Uint32Array | undefined;
      if (indexCount > 0) {
        indexData = new Uint32Array(buffer, offset, indexCount);
        offset += indexCount * 4;
      }
      
      // Read visibility_data if present - 1 float per vertex
      let visibilityData: Float32Array | undefined;
      if (hasVisibility) {
        visibilityData = new Float32Array(buffer, offset, vertexCount);
        offset += vertexCount * 4;
      }

      batchLods.push({
        vertexCount: vertexCount,
        indexCount: indexCount > 0 ? indexCount : undefined,
        vertexData: vertexData,
        indexData: indexData,
        visibilityData: visibilityData,
      });
    }
    geometry.batch = batchLods;
  }

  // Parse batch_colored geometry (polygons with alpha)
  const numBatchColoredLods = view.getUint32(offset, true);
  offset += 4;

  if (numBatchColoredLods > 0) {
    const batchColoredLods: GeometryLOD[] = [];
    for (let i = 0; i < numBatchColoredLods; i++) {
      const vertexCount = view.getUint32(offset, true); // Number of vertices (not floats)
      offset += 4;
      const indexCount = view.getUint32(offset, true);
      offset += 4;
      
      // Read flags: bit 0 = alpha, bit 1 = visibility
      const flags = view.getUint8(offset);
      const hasAlpha = (flags & 1) !== 0;
      const hasVisibility = (flags & 2) !== 0;
      offset += 1;
      // Skip padding (3 bytes)
      offset += 3;

      // Read vertex_data - each vertex is 2 floats (x, y)
      const numFloats = vertexCount * 2;
      const vertexData = new Float32Array(buffer, offset, numFloats);
      offset += numFloats * 4;

      // Read index_data if present
      let indexData: Uint32Array | undefined;
      if (indexCount > 0) {
        indexData = new Uint32Array(buffer, offset, indexCount);
        offset += indexCount * 4;
      }

      // Read alpha_data if present - 1 float per vertex
      let alphaData: Float32Array | undefined;
      if (hasAlpha) {
        alphaData = new Float32Array(buffer, offset, vertexCount);
        offset += vertexCount * 4;
      }
      
      // Read visibility_data if present - 1 float per vertex
      let visibilityData: Float32Array | undefined;
      if (hasVisibility) {
        visibilityData = new Float32Array(buffer, offset, vertexCount);
        offset += vertexCount * 4;
      }

      batchColoredLods.push({
        vertexCount: vertexCount,
        indexCount: indexCount > 0 ? indexCount : undefined,
        vertexData: vertexData,
        indexData: indexData,
        alphaData: alphaData,
        visibilityData: visibilityData,
      });
    }
    geometry.batch_colored = batchColoredLods;
  }

  // Parse instanced_rot geometry (pads with rotation)
  const numInstancedRotLods = view.getUint32(offset, true);
  offset += 4;

  if (numInstancedRotLods > 0) {
    const instancedRotLods: GeometryLOD[] = [];
    for (let i = 0; i < numInstancedRotLods; i++) {
      const vertexCount = view.getUint32(offset, true); // Number of vertices (not floats)
      offset += 4;
      const indexCount = view.getUint32(offset, true);
      offset += 4;
      const instanceCount = view.getUint32(offset, true);
      offset += 4;

      if (vertexCount > 10000000) {
        throw new Error(`[BinaryParser] Sanity check failed: instanced_rot vertexCount ${vertexCount} is too large`);
      }

      // Read vertex_data (base shape) - each vertex is 2 floats (x, y)
      const numFloats = vertexCount * 2;
      const vertexData = new Float32Array(buffer, offset, numFloats);
      offset += numFloats * 4;

      // Read index_data if present
      let indexData: Uint32Array | undefined;
      if (indexCount > 0) {
        indexData = new Uint32Array(buffer, offset, indexCount);
        offset += indexCount * 4;
      }

      // Read instance_data (x, y, rotation per instance)
      let instanceData: Float32Array | undefined;
      if (instanceCount > 0) {
        // MUST match Rust serialization (3 floats per instance)
        instanceData = new Float32Array(buffer, offset, instanceCount * 3);
        offset += instanceCount * 3 * 4;
      }

      instancedRotLods.push({
        vertexCount: vertexCount,
        indexCount: indexCount > 0 ? indexCount : undefined,
        instanceCount: instanceCount > 0 ? instanceCount : undefined,
        vertexData: vertexData,
        indexData: indexData,
        instanceData: instanceData,
      });
    }
    geometry.instanced_rot = instancedRotLods;
  }

  // Parse instanced geometry (vias without rotation)
  const numInstancedLods = view.getUint32(offset, true);
  offset += 4;

  if (numInstancedLods > 0) {
    const instancedLods: GeometryLOD[] = [];
    for (let i = 0; i < numInstancedLods; i++) {
      const vertexCount = view.getUint32(offset, true); // Number of vertices (not floats)
      offset += 4;
      const indexCount = view.getUint32(offset, true);
      offset += 4;
      const instanceCount = view.getUint32(offset, true);
      offset += 4;

      if (vertexCount > 10000000) {
        throw new Error(`[BinaryParser] Sanity check failed: instanced vertexCount ${vertexCount} is too large`);
      }

      // Read vertex_data (base shape) - each vertex is 2 floats (x, y)
      const numFloats = vertexCount * 2;
      const vertexData = new Float32Array(buffer, offset, numFloats);
      offset += numFloats * 4;

      // Read index_data if present
      let indexData: Uint32Array | undefined;
      if (indexCount > 0) {
        indexData = new Uint32Array(buffer, offset, indexCount);
        offset += indexCount * 4;
      }

      // Read instance_data (x, y, packed_vis per instance)
      let instanceData: Float32Array | undefined;
      if (instanceCount > 0) {
        // MUST match Rust serialization (3 floats per instance)
        instanceData = new Float32Array(buffer, offset, instanceCount * 3);
        offset += instanceCount * 3 * 4;
      }

      instancedLods.push({
        vertexCount: vertexCount,
        indexCount: indexCount > 0 ? indexCount : undefined,
        instanceCount: instanceCount > 0 ? instanceCount : undefined,
        vertexData: vertexData,
        indexData: indexData,
        instanceData: instanceData,
      });
    }
    geometry.instanced = instancedLods;
  }

  return geometry;
}

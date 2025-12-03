/**
 * Web Worker for parsing binary layer data
 * Runs on a separate thread to avoid blocking the main thread
 */

import { parseBinaryLayer } from "./binaryParser";
import { LayerJSON } from "../types";

// Worker message types
interface ParseRequest {
  type: "parse";
  id: number;
  buffer: ArrayBuffer;
}

interface ParseResponse {
  type: "parsed";
  id: number;
  layer: LayerJSON;
  parseTime: number;
}

interface ErrorResponse {
  type: "error";
  id: number;
  error: string;
}

// Listen for messages from main thread
self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { type, id, buffer } = event.data;

  if (type === "parse") {
    const startTime = performance.now();
    
    try {
      const layer = parseBinaryLayer(buffer);
      const parseTime = performance.now() - startTime;

      const response: ParseResponse = {
        type: "parsed",
        id,
        layer,
        parseTime,
      };

      // Send parsed data back to main thread
      // Transfer ArrayBuffers back to avoid copying
      const transferables = extractTransferables(layer);
      (self as any).postMessage(response, transferables);
      
    } catch (error) {
      const errorResponse: ErrorResponse = {
        type: "error",
        id,
        error: error instanceof Error ? error.message : String(error),
      };
      (self as any).postMessage(errorResponse);
    }
  }
};

/**
 * Extract all ArrayBuffer/TypedArray objects from the layer data
 * so they can be transferred (not copied) back to main thread
 */
function extractTransferables(layer: LayerJSON): Transferable[] {
  const bufferSet = new Set<ArrayBuffer>();

  const processGeometry = (geometry: any) => {
    if (!geometry) return;

    for (const shaderType of Object.keys(geometry)) {
      const lods = geometry[shaderType];
      if (!Array.isArray(lods)) continue;

      for (const lod of lods) {
        if (lod.vertexData?.buffer instanceof ArrayBuffer) {
          bufferSet.add(lod.vertexData.buffer);
        }
        if (lod.indexData?.buffer instanceof ArrayBuffer) {
          bufferSet.add(lod.indexData.buffer);
        }
        if (lod.instanceData?.buffer instanceof ArrayBuffer) {
          bufferSet.add(lod.instanceData.buffer);
        }
        if (lod.alphaData?.buffer instanceof ArrayBuffer) {
          bufferSet.add(lod.alphaData.buffer);
        }
      }
    }
  };

  processGeometry(layer.geometry);
  return Array.from(bufferSet);
}

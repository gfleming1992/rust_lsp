import { ObjectRange } from "../types";
import { SceneState, getShaderKey, getRenderKey } from "./SceneState";

/** Object visibility and highlighting operations */
export class ObjectVisibility {
  // Maps object ID to its actual render layer (for flipped objects)
  // This persists across selections - once an object is flipped, we always
  // need to look up its geometry in the original layer buffer.
  private objectRenderLayer: Map<number, string> = new Map();
  
  constructor(private sceneState: SceneState) {}
  
  /**
   * Record that an object's geometry is in a specific layer.
   * Call this when flipping - pass the original layer (where geometry lives).
   * NOTE: We only record the FIRST flip's layer. Once an object has been flipped,
   * the geometry stays in the original layer's GPU buffer, so we must never overwrite.
   */
  public remapObjectRenderLayer(objectId: number, renderLayerId: string) {
    // CRITICAL: Only set mapping if not already set.
    // After first flip: F.Cu -> B.Cu, geometry stays in F.Cu buffer
    // After second flip: B.Cu -> F.Cu (logical), geometry STILL in F.Cu buffer
    // We must always point to the original layer where GPU geometry lives.
    if (this.objectRenderLayer.has(objectId)) {
      console.log(`[ObjectVisibility] Keeping existing render layer mapping for object ${objectId} -> ${this.objectRenderLayer.get(objectId)} (ignoring new: ${renderLayerId})`);
      return;
    }
    this.objectRenderLayer.set(objectId, renderLayerId);
    console.log(`[ObjectVisibility] Remapped object ${objectId} to render from ${renderLayerId}`);
  }
  
  /**
   * Get the actual render layer for an object (may differ from logical layer after flip)
   */
  public getActualRenderLayer(range: ObjectRange): string {
    const mapped = this.objectRenderLayer.get(range.id);
    if (mapped) {
      console.log(`[ObjectVisibility] getActualRenderLayer(${range.id}): found mapping -> ${mapped} (logical: ${range.layer_id})`);
      return mapped;
    }
    console.log(`[ObjectVisibility] getActualRenderLayer(${range.id}): no mapping, using logical layer ${range.layer_id}`);
    return range.layer_id;
  }

  /** Resolve actual render layer by id + provided logical layer (for MoveOperations) */
  public getActualRenderLayerById(objectId: number, logicalLayerId: string): string {
    const mapped = this.objectRenderLayer.get(objectId);
    return mapped || logicalLayerId;
  }

  public hideObject(range: ObjectRange) {
    const actualLayerId = this.getActualRenderLayer(range);
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(actualLayerId, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
      this.hideInstanced(renderData, range);
    } else {
      this.hideBatched(renderData, range);
    }
    
    this.sceneState.device?.queue.submit([]);
    this.sceneState.state.needsDraw = true;
  }

  public showObject(range: ObjectRange) {
    const actualLayerId = this.getActualRenderLayer(range);
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(actualLayerId, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
      this.showInstanced(renderData, range);
    } else {
      this.showBatched(renderData, range);
    }
    
    this.sceneState.device?.queue.submit([]);
    this.sceneState.state.needsDraw = true;
  }

  public highlightObject(range: ObjectRange) {
    if (this.sceneState.highlightedRanges.length > 0) {
      this.clearHighlightObject();
    }
    this.sceneState.highlightedRanges = [range];
    this.applyHighlight(range);
    this.sceneState.device?.queue.submit([]);
    this.sceneState.state.needsDraw = true;
  }

  public highlightMultipleObjects(ranges: ObjectRange[]) {
    if (this.sceneState.highlightedRanges.length > 0) {
      this.clearHighlightObject();
    }
    this.sceneState.highlightedRanges = [...ranges];
    for (const range of ranges) {
      this.applyHighlight(range);
    }
    this.sceneState.device?.queue.submit([]);
    this.sceneState.state.needsDraw = true;
  }

  public clearHighlightObject() {
    if (this.sceneState.highlightedRanges.length === 0) return;
    
    for (const range of this.sceneState.highlightedRanges) {
      this.clearHighlight(range);
    }
    this.sceneState.highlightedRanges = [];
    this.sceneState.device?.queue.submit([]);
    this.sceneState.state.needsDraw = true;
  }

  // ==================== Private Helpers ====================

  private hideInstanced(renderData: any, range: ObjectRange) {
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    // Find the correct instance by position
    const boundsCenter = { 
      x: (range.bounds[0] + range.bounds[2]) / 2, 
      y: (range.bounds[1] + range.bounds[3]) / 2 
    };
    const cpuBuf0 = renderData.cpuInstanceBuffers[shapeIdx];
    let actualInstanceIndex = range.instance_index!;
    if (cpuBuf0) {
      const foundIdx = this.findInstanceByPosition(cpuBuf0, boundsCenter.x, boundsCenter.y);
      if (foundIdx !== null) {
        actualInstanceIndex = foundIdx;
      }
    }
    
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;

      const offset = actualInstanceIndex * 3 + 2;
      if (offset < cpuBuffer.length) {
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        view.setUint32(offset * 4, packed & ~1, true); // Clear visible bit
        
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
      }
    }
  }

  private hideBatched(renderData: any, range: ObjectRange) {
    for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
      const [start, count] = range.vertex_ranges[lodIndex];
      if (count === 0) continue;
      
      const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
      const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer || start + count > cpuBuffer.length) continue;
      
      for (let i = 0; i < count; i++) cpuBuffer[start + i] = 0.0;
      this.sceneState.device?.queue.writeBuffer(gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4);
    }
  }

  private showInstanced(renderData: any, range: ObjectRange) {
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    // Find the correct instance by position
    const boundsCenter = { 
      x: (range.bounds[0] + range.bounds[2]) / 2, 
      y: (range.bounds[1] + range.bounds[3]) / 2 
    };
    const cpuBuf0 = renderData.cpuInstanceBuffers[shapeIdx];
    let actualInstanceIndex = range.instance_index!;
    if (cpuBuf0) {
      const foundIdx = this.findInstanceByPosition(cpuBuf0, boundsCenter.x, boundsCenter.y);
      if (foundIdx !== null) {
        actualInstanceIndex = foundIdx;
      }
    }
    
    for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;

      const offset = actualInstanceIndex * 3 + 2;
      if (offset < cpuBuffer.length) {
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        view.setUint32(offset * 4, packed | 1, true); // Set visible bit
        
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
      }
    }
  }

  private showBatched(renderData: any, range: ObjectRange) {
    for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
      const [start, count] = range.vertex_ranges[lodIndex];
      if (count === 0) continue;
      
      const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
      const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer || start + count > cpuBuffer.length) continue;
      
      for (let i = 0; i < count; i++) cpuBuffer[start + i] = 1.0;
      this.sceneState.device?.queue.writeBuffer(gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4);
    }
  }

  /**
   * Find the instance index in the buffer that matches the given position.
   * After flip/rotate/move, the instance_index from the LSP may be stale -
   * the buffer positions have been updated but instance_index hasn't.
   * So we search by position instead.
   */
  private findInstanceByPosition(
    cpuBuffer: Float32Array,
    targetX: number,
    targetY: number,
    tolerance: number = 0.5
  ): number | null {
    const numInstances = Math.floor(cpuBuffer.length / 3);
    let bestIdx = -1;
    let bestDist = Infinity;
    
    for (let i = 0; i < numInstances; i++) {
      const x = cpuBuffer[i * 3];
      const y = cpuBuffer[i * 3 + 1];
      const dx = x - targetX;
      const dy = y - targetY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    
    if (bestDist <= tolerance) {
      return bestIdx;
    }
    return null;
  }

  private applyHighlight(range: ObjectRange) {
    const actualLayerId = this.getActualRenderLayer(range);
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(actualLayerId, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) {
      console.warn(`[ObjectVisibility] No render data for ${renderKey} (object ${range.id}, logical layer ${range.layer_id}, actual render layer ${actualLayerId})`);
      // List available render keys for debugging
      const availableKeys = Array.from(this.sceneState.layerRenderData.keys()).filter(k => k.includes('instanced'));
      console.warn(`[ObjectVisibility] Available instanced render keys: ${availableKeys.slice(0, 10).join(', ')}`);
      return;
    }
    
    if (range.instance_index !== undefined && range.instance_index !== null) {
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      
      if (shapeIdx >= numShapes) {
        console.warn(`[ObjectVisibility] Highlight skipped: obj ${range.id} shapeIdx=${shapeIdx} >= numShapes=${numShapes} (totalLODs=${totalLODs})`);
        return;
      }
      
      // Compute target position from bounds
      const boundsCenter = { 
        x: (range.bounds[0] + range.bounds[2]) / 2, 
        y: (range.bounds[1] + range.bounds[3]) / 2 
      };
      
      // Get the CPU buffer for LOD 0 to find the correct instance
      const lodIndex0 = shapeIdx; // LOD 0
      const cpuBuf0 = renderData.cpuInstanceBuffers[lodIndex0];
      
      // Find the actual instance index by searching for matching position
      // This handles the case where the buffer has been updated by transforms
      // but the LSP's instance_index is stale
      let actualInstanceIndex = range.instance_index;
      
      if (cpuBuf0) {
        // Debug: log all instances in this shape to understand the buffer state
        const numInst = Math.floor(cpuBuf0.length / 3);
        console.log(`[ObjectVisibility] Shape ${shapeIdx} has ${numInst} instances, looking for (${boundsCenter.x.toFixed(1)}, ${boundsCenter.y.toFixed(1)})`);
        for (let i = 0; i < Math.min(numInst, 10); i++) {
          const x = cpuBuf0[i * 3];
          const y = cpuBuf0[i * 3 + 1];
          const dist = Math.sqrt((x - boundsCenter.x) ** 2 + (y - boundsCenter.y) ** 2);
          console.log(`[ObjectVisibility]   [${i}] = (${x.toFixed(1)}, ${y.toFixed(1)}) dist=${dist.toFixed(2)}`);
        }
        
        const foundIdx = this.findInstanceByPosition(cpuBuf0, boundsCenter.x, boundsCenter.y);
        if (foundIdx !== null) {
          if (foundIdx !== range.instance_index) {
            console.log(`[ObjectVisibility] Corrected instance_index: LSP said ${range.instance_index}, found at ${foundIdx} for pos (${boundsCenter.x.toFixed(1)}, ${boundsCenter.y.toFixed(1)})`);
          }
          actualInstanceIndex = foundIdx;
        } else {
          console.warn(`[ObjectVisibility] Could not find instance for obj ${range.id} at (${boundsCenter.x.toFixed(1)}, ${boundsCenter.y.toFixed(1)}) in shape ${shapeIdx}`);
          // Fall back to LSP-provided index
        }
      }
      
      console.log(`[ObjectVisibility] Highlighting obj ${range.id}: layer=${range.layer_id}→${actualLayerId}, instIdx=${actualInstanceIndex} (LSP: ${range.instance_index}), shapeIdx=${shapeIdx}/${numShapes}`);
      
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs) {
          continue;
        }
        
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer) {
          continue;
        }

        const offset = actualInstanceIndex * 3 + 2;
        if (offset >= cpuBuffer.length) {
          continue;
        }
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        view.setUint32(offset * 4, packed | 2, true); // Set highlight bit
        
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
      }
      
      // Store the corrected instance index for clearing later
      (range as any)._actualInstanceIndex = actualInstanceIndex;
    } else {
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0) continue;
        
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer || start + count > cpuBuffer.length) continue;
        
        for (let i = 0; i < count; i++) cpuBuffer[start + i] = 2.0; // Highlighted
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4);
      }
    }
  }

  private clearHighlight(range: ObjectRange) {
    const actualLayerId = this.getActualRenderLayer(range);
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(actualLayerId, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      
      if (shapeIdx >= numShapes) {
        console.warn(`[ObjectVisibility] ClearHighlight skipped: obj ${range.id} shapeIdx=${shapeIdx} >= numShapes=${numShapes} (totalLODs=${totalLODs})`);
        return;
      }
      
      // Use the corrected instance index if we stored it during highlight
      const actualInstanceIndex = (range as any)._actualInstanceIndex ?? range.instance_index;
      
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs) {
          continue;
        }
        
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer) {
          continue;
        }

        const offset = actualInstanceIndex * 3 + 2;
        if (offset >= cpuBuffer.length) {
          continue;
        }
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        view.setUint32(offset * 4, packed & ~2, true); // Clear highlight bit
        
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
      }
    } else {
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0) continue;
        
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer || start + count > cpuBuffer.length) continue;
        
        for (let i = 0; i < count; i++) cpuBuffer[start + i] = 1.0; // Normal visible
        this.sceneState.device?.queue.writeBuffer(gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4);
      }
    }
  }
}

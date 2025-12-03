import { ObjectRange } from "../types";
import { SceneState, getShaderKey, getRenderKey } from "./SceneState";

/** Move operation handling - preview and apply object movement */
export class MoveOperations {
  constructor(private sceneState: SceneState) {}

  /** Get current move offset for shader uniform */
  public getMoveOffset(): { x: number; y: number } {
    return { x: this.sceneState.globalMoveOffsetX, y: this.sceneState.globalMoveOffsetY };
  }

  /** Start a move operation - marks objects as "moving" */
  public startMove(objects: ObjectRange[]) {
    this.sceneState.movingObjects = [...objects];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    
    for (const range of objects) {
      this.setMovingFlag(range, true);
    }
    console.log(`[Scene] Started move for ${objects.length} objects`);
  }

  /** Update move offset - shader applies this to "moving" objects */
  public updateMove(deltaX: number, deltaY: number) {
    this.sceneState.globalMoveOffsetX = deltaX;
    this.sceneState.globalMoveOffsetY = deltaY;
    this.sceneState.state.needsDraw = true;
  }

  /** Finalize move - apply delta to positions, clear moving flags */
  public endMove(): { deltaX: number; deltaY: number } {
    const result = { 
      deltaX: this.sceneState.globalMoveOffsetX, 
      deltaY: this.sceneState.globalMoveOffsetY 
    };
    
    for (const range of this.sceneState.movingObjects) {
      if (range.instance_index !== undefined && range.instance_index !== null) {
        this.applyDeltaToInstance(range, result.deltaX, result.deltaY);
      } else {
        this.applyDeltaToBatch(range, result.deltaX, result.deltaY);
      }
      this.setMovingFlag(range, false);
    }
    
    this.sceneState.movingObjects = [];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    this.sceneState.state.needsDraw = true;
    
    console.log(`[Scene] Move ended, delta: (${result.deltaX.toFixed(3)}, ${result.deltaY.toFixed(3)})`);
    return result;
  }

  /** Cancel move - clear moving flags without applying */
  public cancelMove() {
    for (const range of this.sceneState.movingObjects) {
      this.setMovingFlag(range, false);
    }
    
    this.sceneState.movingObjects = [];
    this.sceneState.globalMoveOffsetX = 0;
    this.sceneState.globalMoveOffsetY = 0;
    this.sceneState.state.needsDraw = true;
    console.log('[Scene] Move cancelled');
  }

  /** Apply delta to objects directly (for undo/redo) */
  public applyMoveOffset(objects: ObjectRange[], deltaX: number, deltaY: number) {
    for (const range of objects) {
      if (range.instance_index !== undefined && range.instance_index !== null) {
        this.applyDeltaToInstance(range, deltaX, deltaY);
      } else {
        this.applyDeltaToBatch(range, deltaX, deltaY);
      }
    }
    this.sceneState.state.needsDraw = true;
  }

  // ==================== Private Helpers ====================

  private setMovingFlag(range: ObjectRange, moving: boolean) {
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    if (shaderKey === 'batch' || shaderKey === 'batch_colored') {
      // Batch: visibility 3.0 = moving, 2.0 = highlighted
      const targetVis = moving ? 3.0 : 2.0;
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const [start, count] = range.vertex_ranges[lodIndex] || [0, 0];
        if (count === 0) continue;
        
        for (let i = start; i < start + count && i < cpuBuffer.length; i++) {
          cpuBuffer[i] = targetVis;
        }
        
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer, start * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + start * 4, count * 4
        );
      }
    } else if (range.instance_index !== undefined && range.instance_index !== null) {
      // Instanced: bit 2 (value 4) = moving flag
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs) continue;
        
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer) continue;
        
        const offset = range.instance_index * 3 + 2;
        if (offset >= cpuBuffer.length) continue;
        
        const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
        const packed = view.getUint32(offset * 4, true);
        const newPacked = moving ? (packed | 4) : (packed & ~4);
        view.setUint32(offset * 4, newPacked, true);
        
        this.sceneState.device?.queue.writeBuffer(
          gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4
        );
      }
    }
  }

  private applyDeltaToInstance(range: ObjectRange, deltaX: number, deltaY: number) {
    if (range.instance_index === undefined || range.instance_index === null) return;
    
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const totalLODs = renderData.cpuInstanceBuffers.length;
    const numShapes = Math.floor(totalLODs / 3);
    const shapeIdx = range.shape_index ?? 0;
    
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const offset = range.instance_index * 3;
      if (offset + 1 >= cpuBuffer.length) continue;
      
      cpuBuffer[offset] += deltaX;
      cpuBuffer[offset + 1] += deltaY;
      
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 8
      );
    }
  }

  private applyDeltaToBatch(range: ObjectRange, deltaX: number, deltaY: number) {
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;
    
    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;
    
    const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVertexBuffers.length);
    
    for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
      const cpuBuffer = renderData.cpuVertexBuffers[lodIndex];
      const gpuBuffer = renderData.lodBuffers[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;
      
      const [start, count] = range.vertex_ranges[lodIndex] || [0, 0];
      if (count === 0) continue;
      
      const floatStart = start * 2;
      const floatCount = count * 2;
      if (floatStart + floatCount > cpuBuffer.length) continue;
      
      for (let i = 0; i < count; i++) {
        const idx = floatStart + i * 2;
        cpuBuffer[idx] += deltaX;
        cpuBuffer[idx + 1] += deltaY;
      }
      
      this.sceneState.device?.queue.writeBuffer(
        gpuBuffer, floatStart * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + floatStart * 4, floatCount * 4
      );
    }
  }
}

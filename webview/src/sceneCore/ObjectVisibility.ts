import { ObjectRange } from "../types";
import { SceneState, getShaderKey, getRenderKey } from "./SceneState";

/** Object visibility and highlighting operations */
export class ObjectVisibility {
  constructor(private sceneState: SceneState) {}

  public hideObject(range: ObjectRange) {
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(range.layer_id, shaderKey);
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
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(range.layer_id, shaderKey);
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
    
    for (let lod = 0; lod < 3; lod++) {
      const lodIndex = lod * numShapes + shapeIdx;
      if (lodIndex >= totalLODs) continue;
      
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;

      const offset = range.instance_index! * 3 + 2;
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
    for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
      const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
      const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
      if (!cpuBuffer || !gpuBuffer) continue;

      const offset = range.instance_index! * 3 + 2;
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

  private applyHighlight(range: ObjectRange) {
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
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
        if (offset < cpuBuffer.length) {
          const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
          const packed = view.getUint32(offset * 4, true);
          view.setUint32(offset * 4, packed | 2, true); // Set highlight bit
          
          this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
        }
      }
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
    const shaderKey = getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = getRenderKey(range.layer_id, shaderKey);
    const renderData = this.sceneState.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
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
        if (offset < cpuBuffer.length) {
          const view = new DataView(cpuBuffer.buffer, cpuBuffer.byteOffset);
          const packed = view.getUint32(offset * 4, true);
          view.setUint32(offset * 4, packed & ~2, true); // Clear highlight bit
          
          this.sceneState.device?.queue.writeBuffer(gpuBuffer, offset * 4, cpuBuffer.buffer, cpuBuffer.byteOffset + offset * 4, 4);
        }
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

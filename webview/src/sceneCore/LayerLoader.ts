import { LayerJSON, GeometryLOD, LayerColor, ShaderGeometry } from "../types";
import { SceneState } from "./SceneState";

/** Layer geometry loading - handles batch and instanced geometry */
export class LayerLoader {
  constructor(private sceneState: SceneState) {}

  /** Load all geometry types for a layer */
  public loadLayerData(layerJson: LayerJSON) {
    const loadStart = performance.now();
    const { device, pipelines } = this.sceneState;
    if (!device || !pipelines) {
      console.warn("Cannot load layer data: Device or pipelines not set");
      return;
    }

    // Register layer metadata
    const id = layerJson.layerId;
    const name = layerJson.layerName || id;
    const defaultColor = [...(layerJson.defaultColor ?? [0.8, 0.8, 0.8, 1])] as LayerColor;
    this.sceneState.layerInfoMap.set(id, { id, name, defaultColor });
    
    if (!this.sceneState.layerOrder.includes(id)) {
      this.sceneState.layerOrder.push(id);
    }
    
    this.sceneState.layerColors.set(id, [...defaultColor] as LayerColor);
    if (!this.sceneState.layerVisible.has(id)) {
      this.sceneState.layerVisible.set(id, true);
    }

    // Load geometry types
    const geometryTypes: Array<[keyof ShaderGeometry, GeometryLOD[] | undefined]> = [
      ["batch", layerJson.geometry.batch],
      ["batch_colored", layerJson.geometry.batch_colored],
      ["batch_instanced", layerJson.geometry.batch_instanced],
      ["batch_instanced_rot", layerJson.geometry.batch_instanced_rot],
      ["instanced_rot_colored", layerJson.geometry.instanced_rot_colored],
      ["instanced_rot", layerJson.geometry.instanced_rot],
      ["instanced_colored", layerJson.geometry.instanced_colored],
      ["instanced", layerJson.geometry.instanced],
      ["basic", layerJson.geometry.basic]
    ];

    let loadedAny = false;
    for (const [shaderKey, lods] of geometryTypes) {
      if (!lods || lods.length === 0) continue;
      loadedAny = true;
      const renderKey = shaderKey === 'batch' ? layerJson.layerId : `${layerJson.layerId}_${shaderKey}`;
      
      if (shaderKey === 'instanced' || shaderKey === 'instanced_rot') {
        this.loadInstancedGeometry(layerJson, renderKey, shaderKey, lods);
      } else {
        this.loadBatchGeometry(layerJson, renderKey, shaderKey, lods);
      }
    }

    if (!loadedAny) console.warn(`No geometry for layer ${layerJson.layerId}`);
    console.log(`[SCENE] Loaded ${layerJson.layerId} in ${(performance.now() - loadStart).toFixed(1)}ms`);
    this.sceneState.state.needsDraw = true;
  }

  private loadBatchGeometry(
    layerJson: LayerJSON, renderKey: string,
    shaderKey: keyof ShaderGeometry, geometryLODs: GeometryLOD[]
  ) {
    const { device, pipelines, uniformData } = this.sceneState;
    if (!device || !pipelines) return;

    const lodBuffers: GPUBuffer[] = [];
    const lodAlphaBuffers: (GPUBuffer | null)[] = [];
    const lodVisibilityBuffers: (GPUBuffer | null)[] = [];
    const cpuVertexBuffers: (Float32Array | null)[] = [];
    const cpuVisibilityBuffers: (Float32Array | null)[] = [];
    const lodVertexCounts: number[] = [];
    const lodIndexBuffers: (GPUBuffer | null)[] = [];
    const lodIndexCounts: number[] = [];

    for (const lod of geometryLODs) {
      if (!lod) continue;
      
      // Decode vertex data
      const lodVertices = this.decodeFloat32(lod.vertexData, true);
      cpuVertexBuffers.push(lodVertices);
      
      lodBuffers.push(this.createVertexBuffer(device, lodVertices));
      lodVertexCounts.push(lod.vertexCount);

      // Alpha data
      const alphaArr = lod.alphaData 
        ? this.decodeFloat32(lod.alphaData, false)
        : this.filledFloat32(lod.vertexCount, 1.0);
      lodAlphaBuffers.push(this.createVertexBuffer(device, alphaArr));

      // Visibility data (must copy to avoid memory leak)
      const visArr = lod.visibilityData
        ? this.decodeFloat32(lod.visibilityData, true)
        : this.filledFloat32(lod.vertexCount, 1.0);
      lodVisibilityBuffers.push(this.createVertexBuffer(device, visArr));
      cpuVisibilityBuffers.push(visArr);

      // Index data
      if (lod.indexData && lod.indexCount && lod.indexCount > 0) {
        const idxArr = this.decodeUint32(lod.indexData);
        lodIndexBuffers.push(this.createIndexBuffer(device, idxArr));
        lodIndexCounts.push(lod.indexCount);
      } else {
        lodIndexBuffers.push(null);
        lodIndexCounts.push(0);
      }
    }
    
    const color = this.sceneState.getLayerColor(layerJson.layerId);
    uniformData.set(color, 0);
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    const pipeline = shaderKey === 'batch' ? pipelines.noAlpha : pipelines.withAlpha;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
    });

    this.sceneState.layerRenderData.set(renderKey, {
      layerId: layerJson.layerId, shaderType: shaderKey,
      lodBuffers, lodAlphaBuffers, lodVisibilityBuffers,
      cpuVertexBuffers, cpuVisibilityBuffers, cpuInstanceBuffers: [],
      lodVertexCounts, lodIndexBuffers, lodIndexCounts,
      currentLOD: 0, uniformBuffer, bindGroup
    });
  }

  private loadInstancedGeometry(
    layerJson: LayerJSON, renderKey: string,
    shaderKey: 'instanced' | 'instanced_rot', geometryLODs: GeometryLOD[]
  ) {
    const { device, pipelines, uniformData } = this.sceneState;
    if (!device || !pipelines) return;

    const lodBuffers: GPUBuffer[] = [];
    const lodInstanceBuffers: GPUBuffer[] = [];
    const cpuInstanceBuffers: (Float32Array | null)[] = [];
    const lodVertexCounts: number[] = [];
    const lodInstanceCounts: number[] = [];
    const lodIndexBuffers: (GPUBuffer | null)[] = [];
    const lodIndexCounts: number[] = [];

    for (const lod of geometryLODs) {
      if (!lod) continue;
      
      const lodVertices = this.decodeFloat32(lod.vertexData, false);
      lodBuffers.push(this.createVertexBuffer(device, lodVertices));
      lodVertexCounts.push(lod.vertexCount);

      if (lod.instanceData && lod.instanceCount) {
        const instanceArr = this.decodeFloat32(lod.instanceData, true);
        lodInstanceBuffers.push(this.createVertexBuffer(device, instanceArr));
        cpuInstanceBuffers.push(instanceArr);
        lodInstanceCounts.push(lod.instanceCount);
      } else {
        lodInstanceBuffers.push(device.createBuffer({ size: 4, usage: GPUBufferUsage.VERTEX }));
        cpuInstanceBuffers.push(null);
        lodInstanceCounts.push(0);
      }

      if (lod.indexData && lod.indexCount && lod.indexCount > 0) {
        const idxArr = this.decodeUint32(lod.indexData);
        lodIndexBuffers.push(this.createIndexBuffer(device, idxArr));
        lodIndexCounts.push(lod.indexCount);
      } else {
        lodIndexBuffers.push(null);
        lodIndexCounts.push(0);
      }
    }
    
    const color = this.sceneState.getLayerColor(layerJson.layerId);
    uniformData.set(color, 0);
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    const pipeline = shaderKey === 'instanced' ? pipelines.instanced : pipelines.instancedRot;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
    });

    this.sceneState.layerRenderData.set(renderKey, {
      layerId: layerJson.layerId, shaderType: shaderKey,
      lodBuffers, lodInstanceBuffers,
      lodAlphaBuffers: [], lodVisibilityBuffers: [],
      cpuVertexBuffers: [], cpuVisibilityBuffers: [], cpuInstanceBuffers,
      lodVertexCounts, lodInstanceCounts, lodIndexBuffers, lodIndexCounts,
      currentLOD: 0, uniformBuffer, bindGroup
    });
  }

  // ==================== Buffer Utilities ====================

  private decodeFloat32(data: Float32Array | string, makeCopy: boolean): Float32Array {
    if (data instanceof Float32Array) {
      if (makeCopy) {
        const copy = new Float32Array(data.length);
        copy.set(data);
        return copy;
      }
      return data;
    }
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  private decodeUint32(data: Uint32Array | string): Uint32Array {
    if (data instanceof Uint32Array) return data;
    const bin = atob(data as unknown as string);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Uint32Array(bytes.buffer);
  }

  private filledFloat32(count: number, value: number): Float32Array {
    const arr = new Float32Array(count);
    arr.fill(value);
    return arr;
  }

  private createVertexBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  private createIndexBuffer(device: GPUDevice, data: Uint32Array): GPUBuffer {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }
}

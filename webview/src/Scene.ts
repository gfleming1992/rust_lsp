import { 
  LayerJSON, 
  LayerRenderData, 
  ViewerState, 
  LayerColor, 
  LayerInfo, 
  ShaderGeometry, 
  GeometryLOD,
  GeometryType,
  ObjectRange
} from "./types";

export class Scene {
  public state: ViewerState = {
    panX: 0,
    panY: 0,
    zoom: 1,
    flipX: false,
    flipY: true,
    dragging: false,
    dragButton: null,
    lastX: 0,
    lastY: 0,
    needsDraw: true
  };

  public layerRenderData = new Map<string, LayerRenderData>();
  public layerInfoMap = new Map<string, LayerInfo>();
  public layerOrder: string[] = [];
  public layerColors = new Map<string, LayerColor>();
  public layerVisible = new Map<string, boolean>();
  public colorOverrides = new Map<string, LayerColor>();
  
  // Global via visibility toggle
  public viasVisible = true;

  private device: GPUDevice | null = null;
  private pipelines: {
    noAlpha: GPURenderPipeline;
    withAlpha: GPURenderPipeline;
    instanced: GPURenderPipeline;
    instancedRot: GPURenderPipeline;
  } | null = null;

  // Shared uniform data buffer for temp use
  private uniformData = new Float32Array(16);

  private BASE_PALETTE: LayerColor[] = [
    [0.95, 0.95, 0.95, 1],
    [0.95, 0.2, 0.2, 1],
    [0.2, 0.8, 0.2, 1],
    [0.3, 0.6, 1.0, 1],
    [1.0, 0.85, 0.2, 1],
    [1.0, 0.4, 0.75, 1],
    [0.95, 0.55, 0.2, 1],
    [0.8, 0.3, 1.0, 1],
    [0.2, 0.9, 0.9, 1],
    [1.0, 0.6, 0.3, 1],
    [0.5, 1.0, 0.3, 1],
    [0.3, 0.4, 0.8, 1],
    [0.9, 0.5, 0.7, 1],
    [0.7, 0.9, 0.5, 1],
    [0.5, 0.7, 0.9, 1],
    [0.9, 0.7, 0.4, 1]
  ];

  constructor() {
    this.loadColorOverrides();
  }

  public setDevice(
    device: GPUDevice, 
    pipelines: {
      noAlpha: GPURenderPipeline;
      withAlpha: GPURenderPipeline;
      instanced: GPURenderPipeline;
      instancedRot: GPURenderPipeline;
    }
  ) {
    this.device = device;
    this.pipelines = pipelines;
  }

  public getLayerColor(layerId: string): LayerColor {
    if (!this.layerColors.has(layerId)) {
      const layer = this.layerInfoMap.get(layerId);
      let base: LayerColor;
      if (layer) {
        base = [...layer.defaultColor] as LayerColor;
      } else {
        const paletteColor = this.BASE_PALETTE[this.hashStr(layerId) % this.BASE_PALETTE.length];
        base = [...paletteColor] as LayerColor;
      }
      if (this.colorOverrides.has(layerId)) {
        base = [...this.colorOverrides.get(layerId)!] as LayerColor;
      }
      this.layerColors.set(layerId, base);
      if (!this.layerVisible.has(layerId)) {
        this.layerVisible.set(layerId, true);
      }
    }
    return this.layerColors.get(layerId)!;
  }

  public setLayerColor(layerId: string, color: LayerColor) {
    this.layerColors.set(layerId, color);
    this.colorOverrides.set(layerId, color);
    this.saveColorOverride(layerId, color);
    this.state.needsDraw = true;
  }

  public resetLayerColor(layerId: string) {
    this.layerColors.delete(layerId);
    this.colorOverrides.delete(layerId);
    this.removeColorOverride(layerId);
    this.state.needsDraw = true;
  }

  public toggleLayerVisibility(layerId: string, visible: boolean) {
    this.layerVisible.set(layerId, visible);
    this.state.needsDraw = true;
  }

  public loadLayerData(layerJson: LayerJSON) {
    const loadStart = performance.now();
    if (!this.device || !this.pipelines) {
      console.warn("Cannot load layer data: Device or pipelines not set");
      return;
    }

    // Register layer metadata
    const id = layerJson.layerId;
    const name = layerJson.layerName || id;
    const defaultColor = [...(layerJson.defaultColor ?? [0.8, 0.8, 0.8, 1])] as LayerColor;
    this.layerInfoMap.set(id, { id, name, defaultColor });
    
    if (!this.layerOrder.includes(id)) {
      this.layerOrder.push(id);
    }
    
    // Always use XML defaultColor, overriding localStorage if present
    // This ensures DictionaryColor from the XML file takes precedence
    this.layerColors.set(id, [...defaultColor] as LayerColor);
    
    if (!this.layerVisible.has(id)) {
      this.layerVisible.set(id, true);
    }

    // Load ALL available geometry types for this layer
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

    let loadedAnyGeometry = false;

    for (const [shaderKey, lods] of geometryTypes) {
      if (!lods || lods.length === 0) continue;
      
      loadedAnyGeometry = true;
      const renderKey = shaderKey === 'batch' ? layerJson.layerId : `${layerJson.layerId}_${shaderKey}`;
      
      if (shaderKey === 'instanced' || shaderKey === 'instanced_rot') {
        this.loadInstancedGeometry(layerJson, renderKey, shaderKey, lods);
      } else {
        this.loadGeometryType(layerJson, renderKey, shaderKey, lods);
      }
    }

    if (!loadedAnyGeometry) {
      console.warn(`No geometry data found for layer ${layerJson.layerId}`);
    }
    
    const loadEnd = performance.now();
    console.log(`[SCENE] Loaded ${layerJson.layerId} in ${(loadEnd - loadStart).toFixed(1)}ms`);
    
    this.state.needsDraw = true;
  }

  private loadGeometryType(
    layerJson: LayerJSON,
    renderKey: string,
    shaderKey: keyof ShaderGeometry,
    geometryLODs: GeometryLOD[]
  ) {
    if (!this.device || !this.pipelines) return;

    const lodBuffers: GPUBuffer[] = [];
    const lodAlphaBuffers: (GPUBuffer | null)[] = [];
    const lodVisibilityBuffers: (GPUBuffer | null)[] = [];
    const cpuVisibilityBuffers: (Float32Array | null)[] = [];
    const lodVertexCounts: number[] = [];
    const lodIndexBuffers: (GPUBuffer | null)[] = [];
    const lodIndexCounts: number[] = [];

    for (let i = 0; i < geometryLODs.length; i++) {
      const lod = geometryLODs[i];
      if (!lod) continue;
      
      // Handle both base64 (from JSON) and typed arrays (from binary)
      let lodVertices: Float32Array;
      if (lod.vertexData instanceof Float32Array) {
        lodVertices = lod.vertexData;
      } else {
        const vertexBin = atob(lod.vertexData as unknown as string);
        const vertexBytes = new Uint8Array(vertexBin.length);
        for (let j = 0; j < vertexBin.length; j++) vertexBytes[j] = vertexBin.charCodeAt(j);
        lodVertices = new Float32Array(vertexBytes.buffer);
      }
      
      const buffer = this.device.createBuffer({
        size: lodVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(buffer.getMappedRange()).set(lodVertices);
      buffer.unmap();
      
      lodBuffers.push(buffer);
      lodVertexCounts.push(lod.vertexCount);

      // Handle Alpha Data
      let alphaArr: Float32Array;
      if (lod.alphaData) {
        if (typeof lod.alphaData === 'object' && lod.alphaData instanceof Float32Array) {
          alphaArr = lod.alphaData;
        } else {
          const alphaBin = atob(lod.alphaData as string);
          const alphaBytes = new Uint8Array(alphaBin.length);
          for (let j = 0; j < alphaBin.length; j++) alphaBytes[j] = alphaBin.charCodeAt(j);
          alphaArr = new Float32Array(alphaBytes.buffer);
        }
      } else {
        alphaArr = new Float32Array(lod.vertexCount);
        alphaArr.fill(1.0);
      }
      
      const alphaBuf = this.device.createBuffer({
        size: alphaArr.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(alphaBuf.getMappedRange()).set(alphaArr);
      alphaBuf.unmap();
      lodAlphaBuffers.push(alphaBuf);

      // Handle Visibility Data
      // IMPORTANT: Copy to a new buffer to avoid keeping the entire parsed ArrayBuffer alive
      let visArr: Float32Array;
      if (lod.visibilityData) {
        if (typeof lod.visibilityData === 'object' && lod.visibilityData instanceof Float32Array) {
          // Copy to new buffer to free the original shared ArrayBuffer
          visArr = new Float32Array(lod.visibilityData);
        } else {
          const visBin = atob(lod.visibilityData as string);
          const visBytes = new Uint8Array(visBin.length);
          for (let j = 0; j < visBin.length; j++) visBytes[j] = visBin.charCodeAt(j);
          visArr = new Float32Array(visBytes.buffer);
        }
      } else {
        visArr = new Float32Array(lod.vertexCount);
        visArr.fill(1.0); // Default visible
      }
      
      const visBuf = this.device.createBuffer({
        size: visArr.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(visBuf.getMappedRange()).set(visArr);
      visBuf.unmap();
      lodVisibilityBuffers.push(visBuf);
      cpuVisibilityBuffers.push(visArr);

      if (lod.indexData && lod.indexCount && lod.indexCount > 0) {
        let idxArr: Uint32Array;
        if (lod.indexData instanceof Uint32Array) {
          idxArr = lod.indexData;
        } else {
          const indexBin = atob(lod.indexData as unknown as string);
          const indexBytes = new Uint8Array(indexBin.length);
          for (let j = 0; j < indexBin.length; j++) indexBytes[j] = indexBin.charCodeAt(j);
          idxArr = new Uint32Array(indexBytes.buffer);
        }
        
        const idxBuf = this.device.createBuffer({
          size: idxArr.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        new Uint32Array(idxBuf.getMappedRange()).set(idxArr);
        idxBuf.unmap();
        lodIndexBuffers.push(idxBuf);
        lodIndexCounts.push(lod.indexCount);
      } else {
        lodIndexBuffers.push(null);
        lodIndexCounts.push(0);
      }
    }
    
    const color = this.getLayerColor(layerJson.layerId);
    this.uniformData.set(color, 0);
    const layerUniformBuffer = this.device.createBuffer({
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    const usePipeline = (shaderKey === 'batch') ? this.pipelines.noAlpha : this.pipelines.withAlpha;
    const layerBindGroup = this.device.createBindGroup({
      layout: usePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: layerUniformBuffer } }]
    });

    this.layerRenderData.set(renderKey, {
      layerId: layerJson.layerId,
      shaderType: shaderKey,
      lodBuffers,
      lodAlphaBuffers,
      lodVisibilityBuffers,
      cpuVisibilityBuffers,
      cpuInstanceBuffers: [],
      lodVertexCounts,
      lodIndexBuffers,
      lodIndexCounts,
      currentLOD: 0,
      uniformBuffer: layerUniformBuffer,
      bindGroup: layerBindGroup
    });
  }

  private loadInstancedGeometry(
    layerJson: LayerJSON,
    renderKey: string,
    shaderKey: 'instanced' | 'instanced_rot',
    geometryLODs: GeometryLOD[]
  ) {
    if (!this.device || !this.pipelines) return;

    const lodBuffers: GPUBuffer[] = [];
    const lodInstanceBuffers: GPUBuffer[] = [];
    const cpuInstanceBuffers: (Float32Array | null)[] = [];
    const lodVertexCounts: number[] = [];
    const lodInstanceCounts: number[] = [];
    const lodIndexBuffers: (GPUBuffer | null)[] = [];
    const lodIndexCounts: number[] = [];

    for (let i = 0; i < geometryLODs.length; i++) {
      const lod = geometryLODs[i];
      if (!lod) continue;
      
      let lodVertices: Float32Array;
      if (lod.vertexData instanceof Float32Array) {
        lodVertices = lod.vertexData;
      } else {
        const vertexBin = atob(lod.vertexData as unknown as string);
        const vertexBytes = new Uint8Array(vertexBin.length);
        for (let j = 0; j < vertexBin.length; j++) vertexBytes[j] = vertexBin.charCodeAt(j);
        lodVertices = new Float32Array(vertexBytes.buffer);
      }
      
      const vertexBuffer = this.device.createBuffer({
        size: lodVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(lodVertices);
      vertexBuffer.unmap();
      lodBuffers.push(vertexBuffer);
      lodVertexCounts.push(lod.vertexCount);

      if (lod.instanceData && lod.instanceCount) {
        let instanceArr: Float32Array;
        if (lod.instanceData instanceof Float32Array) {
          // Copy to new buffer to free the original shared ArrayBuffer
          instanceArr = new Float32Array(lod.instanceData);
        } else {
          const instanceBin = atob(lod.instanceData as unknown as string);
          const instanceBytes = new Uint8Array(instanceBin.length);
          for (let j = 0; j < instanceBin.length; j++) instanceBytes[j] = instanceBin.charCodeAt(j);
          instanceArr = new Float32Array(instanceBytes.buffer);
        }
        
        const instanceBuffer = this.device.createBuffer({
          size: instanceArr.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        new Float32Array(instanceBuffer.getMappedRange()).set(instanceArr);
        instanceBuffer.unmap();
        lodInstanceBuffers.push(instanceBuffer);
        cpuInstanceBuffers.push(instanceArr);
        lodInstanceCounts.push(lod.instanceCount);
      } else {
        const emptyBuffer = this.device.createBuffer({
          size: 4,
          usage: GPUBufferUsage.VERTEX
        });
        lodInstanceBuffers.push(emptyBuffer);
        cpuInstanceBuffers.push(null);
        lodInstanceCounts.push(0);
      }

      if (lod.indexData && lod.indexCount && lod.indexCount > 0) {
        let idxArr: Uint32Array;
        if (lod.indexData instanceof Uint32Array) {
          idxArr = lod.indexData;
        } else {
          const indexBin = atob(lod.indexData as unknown as string);
          const indexBytes = new Uint8Array(indexBin.length);
          for (let j = 0; j < indexBin.length; j++) indexBytes[j] = indexBin.charCodeAt(j);
          idxArr = new Uint32Array(indexBytes.buffer);
        }
        
        const idxBuf = this.device.createBuffer({
          size: idxArr.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        new Uint32Array(idxBuf.getMappedRange()).set(idxArr);
        idxBuf.unmap();
        lodIndexBuffers.push(idxBuf);
        lodIndexCounts.push(lod.indexCount);
      } else {
        lodIndexBuffers.push(null);
        lodIndexCounts.push(0);
      }
    }
    
    const color = this.getLayerColor(layerJson.layerId);
    this.uniformData.set(color, 0);
    const layerUniformBuffer = this.device.createBuffer({
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    const usePipeline = (shaderKey === 'instanced') ? this.pipelines.instanced : this.pipelines.instancedRot;
    const layerBindGroup = this.device.createBindGroup({
      layout: usePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: layerUniformBuffer } }]
    });

    this.layerRenderData.set(renderKey, {
      layerId: layerJson.layerId,
      shaderType: shaderKey,
      lodBuffers,
      lodInstanceBuffers,
      lodAlphaBuffers: [],
      lodVisibilityBuffers: [],
      cpuVisibilityBuffers: [],
      cpuInstanceBuffers,
      lodVertexCounts,
      lodInstanceCounts,
      lodIndexBuffers,
      lodIndexCounts,
      currentLOD: 0,
      uniformBuffer: layerUniformBuffer,
      bindGroup: layerBindGroup
    });
  }

  public hideObject(range: ObjectRange) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey) {
      console.warn('[Scene] hideObject: No shader key for obj_type:', range.obj_type);
      return;
    }

    const renderKey = shaderKey === 'batch' ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData) {
      console.warn('[Scene] hideObject: No render data for:', renderKey);
      return;
    }

    // Hide object in ALL LOD levels to ensure it disappears regardless of zoom
    if (range.instance_index !== undefined && range.instance_index !== null) {
        // Instanced - hide across all LODs
        for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
            const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
            const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            const idx = range.instance_index;
            
            if (shaderKey === 'instanced') {
                // 3 floats: x, y, packed_vis (u32 as float)
                // Stride = 3
                const offset = idx * 3 + 2;
                if (offset < cpuBuffer.length) {
                    const view = new DataView(cpuBuffer.buffer);
                    const byteOffset = cpuBuffer.byteOffset + offset * 4;
                    
                    const currentPacked = view.getUint32(byteOffset, true);
                    const newPacked = currentPacked & ~1; // Clear LSB
                    view.setUint32(byteOffset, newPacked, true);
                    
                    this.device?.queue.writeBuffer(
                        gpuBuffer,
                        offset * 4,
                        cpuBuffer.buffer,
                        byteOffset,
                        4
                    );
                }
            } else if (shaderKey === 'instanced_rot') {
                // 3 floats: x, y, packed_rot_vis (f32)
                // Stride = 3
                const offset = idx * 3 + 2;
                if (offset < cpuBuffer.length) {
                    const view = new DataView(cpuBuffer.buffer);
                    const byteOffset = cpuBuffer.byteOffset + offset * 4;
                    
                    const currentPacked = view.getUint32(byteOffset, true);
                    const newPacked = currentPacked & ~1; // Clear LSB
                    view.setUint32(byteOffset, newPacked, true);
                    
                    this.device?.queue.writeBuffer(
                        gpuBuffer,
                        offset * 4,
                        cpuBuffer.buffer,
                        byteOffset,
                        4
                    );
                }
            }
        }
    } else {
        // Batched - hide across all LODs
        for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
            const [start, count] = range.vertex_ranges[lodIndex];
            if (count === 0) continue; // Skip empty ranges
            
            const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
            const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) {
                continue; // Skip LODs without visibility buffers
            }
            
            // Check bounds
            if (start + count > cpuBuffer.length) {
                console.error(`[Scene] ERROR: Out of bounds LOD${lodIndex}: ${start}-${start + count - 1}, bufLen=${cpuBuffer.length}`);
                continue;
            }
            
            // Set range to 0.0
            for (let i = 0; i < count; i++) {
                cpuBuffer[start + i] = 0.0;
            }
            
            // Update GPU
            this.device?.queue.writeBuffer(
                gpuBuffer,
                start * 4,
                cpuBuffer.buffer,
                cpuBuffer.byteOffset + start * 4,
                count * 4
            );
        }
    }
    
    // Force immediate GPU queue submission
    if (this.device) {
        this.device.queue.submit([]);
    }
    
    this.state.needsDraw = true;
  }

  public showObject(range: ObjectRange) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = shaderKey === 'batch' ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData) return;

    // Show object in ALL LOD levels
    if (range.instance_index !== undefined && range.instance_index !== null) {
        // Instanced - show across all LODs
        for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
            const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
            const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            const idx = range.instance_index;
            
            if (shaderKey === 'instanced') {
                const offset = idx * 3 + 2;
                if (offset < cpuBuffer.length) {
                    const view = new DataView(cpuBuffer.buffer);
                    const byteOffset = cpuBuffer.byteOffset + offset * 4;
                    
                    const currentPacked = view.getUint32(byteOffset, true);
                    const newPacked = currentPacked | 1; // Set LSB (visible)
                    view.setUint32(byteOffset, newPacked, true);
                    
                    this.device?.queue.writeBuffer(
                        gpuBuffer,
                        offset * 4,
                        cpuBuffer.buffer,
                        byteOffset,
                        4
                    );
                }
            } else if (shaderKey === 'instanced_rot') {
                const offset = idx * 3 + 2;
                if (offset < cpuBuffer.length) {
                    const view = new DataView(cpuBuffer.buffer);
                    const byteOffset = cpuBuffer.byteOffset + offset * 4;
                    
                    const currentPacked = view.getUint32(byteOffset, true);
                    const newPacked = currentPacked | 1; // Set LSB (visible)
                    view.setUint32(byteOffset, newPacked, true);
                    
                    this.device?.queue.writeBuffer(
                        gpuBuffer,
                        offset * 4,
                        cpuBuffer.buffer,
                        byteOffset,
                        4
                    );
                }
            }
        }
    } else {
        // Batched - show across all LODs
        for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
            const [start, count] = range.vertex_ranges[lodIndex];
            if (count === 0) continue;
            
            const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
            const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            if (start + count > cpuBuffer.length) continue;
            
            // Set range to 1.0 (visible)
            for (let i = 0; i < count; i++) {
                cpuBuffer[start + i] = 1.0;
            }
            
            // Update GPU
            this.device?.queue.writeBuffer(
                gpuBuffer,
                start * 4,
                cpuBuffer.buffer,
                cpuBuffer.byteOffset + start * 4,
                count * 4
            );
        }
    }
    
    // Force immediate GPU queue submission
    if (this.device) {
        this.device.queue.submit([]);
    }
    
    this.state.needsDraw = true;
  }

  // Track currently highlighted objects for clearing
  private highlightedRanges: ObjectRange[] = [];

  public highlightObject(range: ObjectRange) {
    // Clear previous highlights first
    if (this.highlightedRanges.length > 0) {
      this.clearHighlightObject();
    }
    
    this.highlightedRanges = [range];
    this.applyHighlightToRange(range);
    
    if (this.device) {
        this.device.queue.submit([]);
    }
    
    this.state.needsDraw = true;
  }

  public highlightMultipleObjects(ranges: ObjectRange[]) {
    // Clear previous highlights first
    if (this.highlightedRanges.length > 0) {
      this.clearHighlightObject();
    }
    
    this.highlightedRanges = [...ranges];
    
    for (const range of ranges) {
      this.applyHighlightToRange(range);
    }
    
    if (this.device) {
        this.device.queue.submit([]);
    }
    
    this.state.needsDraw = true;
  }

  private applyHighlightToRange(range: ObjectRange) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey) {
      return;
    }

    const renderKey = shaderKey === 'batch' ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData) {
      return;
    }

    if (range.instance_index !== undefined && range.instance_index !== null) {
        // Instanced - set highlight bit (bit 1)
        for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
            const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
            const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            const idx = range.instance_index;
            const offset = idx * 3 + 2;
            if (offset < cpuBuffer.length) {
                const view = new DataView(cpuBuffer.buffer);
                const byteOffset = cpuBuffer.byteOffset + offset * 4;
                
                const currentPacked = view.getUint32(byteOffset, true);
                const newPacked = currentPacked | 2; // Set bit 1 (highlight)
                view.setUint32(byteOffset, newPacked, true);
                
                this.device?.queue.writeBuffer(
                    gpuBuffer,
                    offset * 4,
                    cpuBuffer.buffer,
                    byteOffset,
                    4
                );
            }
        }
    } else {
        // Batched - set visibility to 2.0 (highlighted)
        const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
        
        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
            const [start, count] = range.vertex_ranges[lodIndex];
            if (count === 0) continue;
            
            const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
            const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            if (start + count > cpuBuffer.length) continue;
            
            // Set range to 2.0 (highlighted)
            for (let i = 0; i < count; i++) {
                cpuBuffer[start + i] = 2.0;
            }
            
            // Update GPU
            this.device?.queue.writeBuffer(
                gpuBuffer,
                start * 4,
                cpuBuffer.buffer,
                cpuBuffer.byteOffset + start * 4,
                count * 4
            );
        }
    }
  }

  public clearHighlightObject() {
    if (this.highlightedRanges.length === 0) return;
    
    for (const range of this.highlightedRanges) {
      this.clearHighlightFromRange(range);
    }
    this.highlightedRanges = [];
    
    if (this.device) {
        this.device.queue.submit([]);
    }
    
    this.state.needsDraw = true;
  }

  private clearHighlightFromRange(range: ObjectRange) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey) return;

    const renderKey = shaderKey === 'batch' ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData) return;

    if (range.instance_index !== undefined && range.instance_index !== null) {
        // Instanced - clear highlight bit (bit 1)
        for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
            const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
            const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            const idx = range.instance_index;
            const offset = idx * 3 + 2;
            if (offset < cpuBuffer.length) {
                const view = new DataView(cpuBuffer.buffer);
                const byteOffset = cpuBuffer.byteOffset + offset * 4;
                
                const currentPacked = view.getUint32(byteOffset, true);
                const newPacked = currentPacked & ~2; // Clear bit 1 (highlight)
                view.setUint32(byteOffset, newPacked, true);
                
                this.device?.queue.writeBuffer(
                    gpuBuffer,
                    offset * 4,
                    cpuBuffer.buffer,
                    byteOffset,
                    4
                );
            }
        }
    } else {
        // Batched - set visibility back to 1.0 (normal visible)
        const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
        
        for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
            const [start, count] = range.vertex_ranges[lodIndex];
            if (count === 0) continue;
            
            const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
            const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
            if (!cpuBuffer || !gpuBuffer) continue;

            if (start + count > cpuBuffer.length) continue;
            
            // Set range back to 1.0 (normal visible)
            for (let i = 0; i < count; i++) {
                cpuBuffer[start + i] = 1.0;
            }
            
            // Update GPU
            this.device?.queue.writeBuffer(
                gpuBuffer,
                start * 4,
                cpuBuffer.buffer,
                cpuBuffer.byteOffset + start * 4,
                count * 4
            );
        }
    }
  }

  private getShaderKey(type: GeometryType): keyof ShaderGeometry | null {
    switch (type) {
      case GeometryType.Batch: return 'batch';
      case GeometryType.BatchColored: return 'batch_colored';
      case GeometryType.BatchInstanced: return 'batch_instanced';
      case GeometryType.BatchInstancedRot: return 'batch_instanced_rot';
      case GeometryType.InstancedRotColored: return 'instanced_rot_colored';
      case GeometryType.InstancedRot: return 'instanced_rot';
      case GeometryType.InstancedColored: return 'instanced_colored';
      case GeometryType.Instanced: return 'instanced';
      case GeometryType.Basic: return 'basic';
      default: return null;
    }
  }

  private hashStr(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private STORAGE_KEY = "layerColorOverrides";

  private saveColorOverride(layerId: string, color: LayerColor) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}") as Record<string, LayerColor>;
      stored[layerId] = color;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      console.error("Failed to save color override", error);
    }
  }

  private removeColorOverride(layerId: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}") as Record<string, LayerColor>;
      delete stored[layerId];
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      console.error("Failed to remove color override", error);
    }
  }

  private loadColorOverrides() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}") as Record<string, LayerColor>;
      for (const [layerId, color] of Object.entries(stored)) {
        if (Array.isArray(color) && color.length === 4) {
          this.colorOverrides.set(layerId, [...color] as LayerColor);
          this.layerColors.set(layerId, [...color] as LayerColor);
        }
      }
    } catch (error) {
      console.error("Failed to load color overrides", error);
    }
  }
}

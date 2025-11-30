// webview/src/Scene.ts
var Scene = class {
  state = {
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
  layerRenderData = /* @__PURE__ */ new Map();
  layerInfoMap = /* @__PURE__ */ new Map();
  layerOrder = [];
  layerColors = /* @__PURE__ */ new Map();
  layerVisible = /* @__PURE__ */ new Map();
  colorOverrides = /* @__PURE__ */ new Map();
  // Global via visibility toggle
  viasVisible = true;
  // DRC overlay state
  drcRegions = [];
  drcEnabled = false;
  drcCurrentIndex = 0;
  drcVertexBuffer = null;
  drcTriangleCount = 0;
  device = null;
  pipelines = null;
  // Shared uniform data buffer for temp use
  uniformData = new Float32Array(16);
  BASE_PALETTE = [
    [0.95, 0.95, 0.95, 1],
    [0.95, 0.2, 0.2, 1],
    [0.2, 0.8, 0.2, 1],
    [0.3, 0.6, 1, 1],
    [1, 0.85, 0.2, 1],
    [1, 0.4, 0.75, 1],
    [0.95, 0.55, 0.2, 1],
    [0.8, 0.3, 1, 1],
    [0.2, 0.9, 0.9, 1],
    [1, 0.6, 0.3, 1],
    [0.5, 1, 0.3, 1],
    [0.3, 0.4, 0.8, 1],
    [0.9, 0.5, 0.7, 1],
    [0.7, 0.9, 0.5, 1],
    [0.5, 0.7, 0.9, 1],
    [0.9, 0.7, 0.4, 1]
  ];
  constructor() {
    this.loadColorOverrides();
  }
  setDevice(device, pipelines) {
    this.device = device;
    this.pipelines = pipelines;
  }
  getLayerColor(layerId) {
    if (!this.layerColors.has(layerId)) {
      const layer = this.layerInfoMap.get(layerId);
      let base;
      if (layer) {
        base = [...layer.defaultColor];
      } else {
        const paletteColor = this.BASE_PALETTE[this.hashStr(layerId) % this.BASE_PALETTE.length];
        base = [...paletteColor];
      }
      if (this.colorOverrides.has(layerId)) {
        base = [...this.colorOverrides.get(layerId)];
      }
      this.layerColors.set(layerId, base);
      if (!this.layerVisible.has(layerId)) {
        this.layerVisible.set(layerId, true);
      }
    }
    return this.layerColors.get(layerId);
  }
  setLayerColor(layerId, color) {
    this.layerColors.set(layerId, color);
    this.colorOverrides.set(layerId, color);
    this.saveColorOverride(layerId, color);
    this.state.needsDraw = true;
  }
  resetLayerColor(layerId) {
    this.layerColors.delete(layerId);
    this.colorOverrides.delete(layerId);
    this.removeColorOverride(layerId);
    this.state.needsDraw = true;
  }
  toggleLayerVisibility(layerId, visible) {
    this.layerVisible.set(layerId, visible);
    this.state.needsDraw = true;
    if (typeof vscode !== "undefined") {
      vscode.postMessage({ command: "SetLayerVisibility", layerId, visible });
    }
  }
  loadLayerData(layerJson) {
    const loadStart = performance.now();
    if (!this.device || !this.pipelines) {
      console.warn("Cannot load layer data: Device or pipelines not set");
      return;
    }
    const id = layerJson.layerId;
    const name = layerJson.layerName || id;
    const defaultColor = [...layerJson.defaultColor ?? [0.8, 0.8, 0.8, 1]];
    this.layerInfoMap.set(id, { id, name, defaultColor });
    if (!this.layerOrder.includes(id)) {
      this.layerOrder.push(id);
    }
    this.layerColors.set(id, [...defaultColor]);
    if (!this.layerVisible.has(id)) {
      this.layerVisible.set(id, true);
    }
    const geometryTypes = [
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
      if (!lods || lods.length === 0)
        continue;
      loadedAnyGeometry = true;
      const renderKey = shaderKey === "batch" ? layerJson.layerId : `${layerJson.layerId}_${shaderKey}`;
      if (shaderKey === "instanced" || shaderKey === "instanced_rot") {
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
  loadGeometryType(layerJson, renderKey, shaderKey, geometryLODs) {
    if (!this.device || !this.pipelines)
      return;
    const lodBuffers = [];
    const lodAlphaBuffers = [];
    const lodVisibilityBuffers = [];
    const cpuVisibilityBuffers = [];
    const lodVertexCounts = [];
    const lodIndexBuffers = [];
    const lodIndexCounts = [];
    for (let i = 0; i < geometryLODs.length; i++) {
      const lod = geometryLODs[i];
      if (!lod)
        continue;
      let lodVertices;
      if (lod.vertexData instanceof Float32Array) {
        lodVertices = lod.vertexData;
      } else {
        const vertexBin = atob(lod.vertexData);
        const vertexBytes = new Uint8Array(vertexBin.length);
        for (let j = 0; j < vertexBin.length; j++)
          vertexBytes[j] = vertexBin.charCodeAt(j);
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
      let alphaArr;
      if (lod.alphaData) {
        if (typeof lod.alphaData === "object" && lod.alphaData instanceof Float32Array) {
          alphaArr = lod.alphaData;
        } else {
          const alphaBin = atob(lod.alphaData);
          const alphaBytes = new Uint8Array(alphaBin.length);
          for (let j = 0; j < alphaBin.length; j++)
            alphaBytes[j] = alphaBin.charCodeAt(j);
          alphaArr = new Float32Array(alphaBytes.buffer);
        }
      } else {
        alphaArr = new Float32Array(lod.vertexCount);
        alphaArr.fill(1);
      }
      const alphaBuf = this.device.createBuffer({
        size: alphaArr.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Float32Array(alphaBuf.getMappedRange()).set(alphaArr);
      alphaBuf.unmap();
      lodAlphaBuffers.push(alphaBuf);
      let visArr;
      if (lod.visibilityData) {
        if (typeof lod.visibilityData === "object" && lod.visibilityData instanceof Float32Array) {
          visArr = new Float32Array(lod.visibilityData.length);
          visArr.set(lod.visibilityData);
        } else {
          const visBin = atob(lod.visibilityData);
          const visBytes = new Uint8Array(visBin.length);
          for (let j = 0; j < visBin.length; j++)
            visBytes[j] = visBin.charCodeAt(j);
          visArr = new Float32Array(visBytes.buffer);
        }
      } else {
        visArr = new Float32Array(lod.vertexCount);
        visArr.fill(1);
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
        let idxArr;
        if (lod.indexData instanceof Uint32Array) {
          idxArr = lod.indexData;
        } else {
          const indexBin = atob(lod.indexData);
          const indexBytes = new Uint8Array(indexBin.length);
          for (let j = 0; j < indexBin.length; j++)
            indexBytes[j] = indexBin.charCodeAt(j);
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
    const usePipeline = shaderKey === "batch" ? this.pipelines.noAlpha : this.pipelines.withAlpha;
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
  loadInstancedGeometry(layerJson, renderKey, shaderKey, geometryLODs) {
    if (!this.device || !this.pipelines)
      return;
    const lodBuffers = [];
    const lodInstanceBuffers = [];
    const cpuInstanceBuffers = [];
    const lodVertexCounts = [];
    const lodInstanceCounts = [];
    const lodIndexBuffers = [];
    const lodIndexCounts = [];
    for (let i = 0; i < geometryLODs.length; i++) {
      const lod = geometryLODs[i];
      if (!lod)
        continue;
      let lodVertices;
      if (lod.vertexData instanceof Float32Array) {
        lodVertices = lod.vertexData;
      } else {
        const vertexBin = atob(lod.vertexData);
        const vertexBytes = new Uint8Array(vertexBin.length);
        for (let j = 0; j < vertexBin.length; j++)
          vertexBytes[j] = vertexBin.charCodeAt(j);
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
        let instanceArr;
        if (lod.instanceData instanceof Float32Array) {
          instanceArr = new Float32Array(lod.instanceData.length);
          instanceArr.set(lod.instanceData);
        } else {
          const instanceBin = atob(lod.instanceData);
          const instanceBytes = new Uint8Array(instanceBin.length);
          for (let j = 0; j < instanceBin.length; j++)
            instanceBytes[j] = instanceBin.charCodeAt(j);
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
        let idxArr;
        if (lod.indexData instanceof Uint32Array) {
          idxArr = lod.indexData;
        } else {
          const indexBin = atob(lod.indexData);
          const indexBytes = new Uint8Array(indexBin.length);
          for (let j = 0; j < indexBin.length; j++)
            indexBytes[j] = indexBin.charCodeAt(j);
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
    const usePipeline = shaderKey === "instanced" ? this.pipelines.instanced : this.pipelines.instancedRot;
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
  hideObject(range) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey)
      return;
    const renderKey = shaderKey === "batch" ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData)
      return;
    if (range.instance_index !== void 0 && range.instance_index !== null) {
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs)
          continue;
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        const idx = range.instance_index;
        const offset = idx * 3 + 2;
        if (offset < cpuBuffer.length) {
          const view = new DataView(cpuBuffer.buffer);
          const byteOffset = cpuBuffer.byteOffset + offset * 4;
          const currentPacked = view.getUint32(byteOffset, true);
          const newPacked = currentPacked & ~1;
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
      for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0)
          continue;
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer) {
          continue;
        }
        if (start + count > cpuBuffer.length) {
          console.error(`[Scene] ERROR: Out of bounds LOD${lodIndex}: ${start}-${start + count - 1}, bufLen=${cpuBuffer.length}`);
          continue;
        }
        for (let i = 0; i < count; i++) {
          cpuBuffer[start + i] = 0;
        }
        this.device?.queue.writeBuffer(
          gpuBuffer,
          start * 4,
          cpuBuffer.buffer,
          cpuBuffer.byteOffset + start * 4,
          count * 4
        );
      }
    }
    if (this.device) {
      this.device.queue.submit([]);
    }
    this.state.needsDraw = true;
  }
  showObject(range) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey)
      return;
    const renderKey = shaderKey === "batch" ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData)
      return;
    if (range.instance_index !== void 0 && range.instance_index !== null) {
      for (let lodIndex = 0; lodIndex < renderData.cpuInstanceBuffers.length; lodIndex++) {
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        const idx = range.instance_index;
        if (shaderKey === "instanced") {
          const offset = idx * 3 + 2;
          if (offset < cpuBuffer.length) {
            const view = new DataView(cpuBuffer.buffer);
            const byteOffset = cpuBuffer.byteOffset + offset * 4;
            const currentPacked = view.getUint32(byteOffset, true);
            const newPacked = currentPacked | 1;
            view.setUint32(byteOffset, newPacked, true);
            this.device?.queue.writeBuffer(
              gpuBuffer,
              offset * 4,
              cpuBuffer.buffer,
              byteOffset,
              4
            );
          }
        } else if (shaderKey === "instanced_rot") {
          const offset = idx * 3 + 2;
          if (offset < cpuBuffer.length) {
            const view = new DataView(cpuBuffer.buffer);
            const byteOffset = cpuBuffer.byteOffset + offset * 4;
            const currentPacked = view.getUint32(byteOffset, true);
            const newPacked = currentPacked | 1;
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
      for (let lodIndex = 0; lodIndex < range.vertex_ranges.length; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0)
          continue;
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        if (start + count > cpuBuffer.length)
          continue;
        for (let i = 0; i < count; i++) {
          cpuBuffer[start + i] = 1;
        }
        this.device?.queue.writeBuffer(
          gpuBuffer,
          start * 4,
          cpuBuffer.buffer,
          cpuBuffer.byteOffset + start * 4,
          count * 4
        );
      }
    }
    if (this.device) {
      this.device.queue.submit([]);
    }
    this.state.needsDraw = true;
  }
  // Track currently highlighted objects for clearing
  highlightedRanges = [];
  highlightObject(range) {
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
  highlightMultipleObjects(ranges) {
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
  applyHighlightToRange(range) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey)
      return;
    const renderKey = shaderKey === "batch" ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData)
      return;
    if (range.instance_index !== void 0 && range.instance_index !== null) {
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs)
          continue;
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        const idx = range.instance_index;
        const offset = idx * 3 + 2;
        if (offset < cpuBuffer.length) {
          const view = new DataView(cpuBuffer.buffer);
          const byteOffset = cpuBuffer.byteOffset + offset * 4;
          const currentPacked = view.getUint32(byteOffset, true);
          const newPacked = currentPacked | 2;
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
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0)
          continue;
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        if (start + count > cpuBuffer.length)
          continue;
        for (let i = 0; i < count; i++) {
          cpuBuffer[start + i] = 2;
        }
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
  clearHighlightObject() {
    if (this.highlightedRanges.length === 0)
      return;
    for (const range of this.highlightedRanges) {
      this.clearHighlightFromRange(range);
    }
    this.highlightedRanges = [];
    if (this.device) {
      this.device.queue.submit([]);
    }
    this.state.needsDraw = true;
  }
  clearHighlightFromRange(range) {
    const shaderKey = this.getShaderKey(range.obj_type);
    if (!shaderKey)
      return;
    const renderKey = shaderKey === "batch" ? range.layer_id : `${range.layer_id}_${shaderKey}`;
    const renderData = this.layerRenderData.get(renderKey);
    if (!renderData)
      return;
    if (range.instance_index !== void 0 && range.instance_index !== null) {
      const totalLODs = renderData.cpuInstanceBuffers.length;
      const numShapes = Math.floor(totalLODs / 3);
      const shapeIdx = range.shape_index ?? 0;
      for (let lod = 0; lod < 3; lod++) {
        const lodIndex = lod * numShapes + shapeIdx;
        if (lodIndex >= totalLODs)
          continue;
        const cpuBuffer = renderData.cpuInstanceBuffers[lodIndex];
        const gpuBuffer = renderData.lodInstanceBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        const idx = range.instance_index;
        const offset = idx * 3 + 2;
        if (offset < cpuBuffer.length) {
          const view = new DataView(cpuBuffer.buffer);
          const byteOffset = cpuBuffer.byteOffset + offset * 4;
          const currentPacked = view.getUint32(byteOffset, true);
          const newPacked = currentPacked & ~2;
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
      const numLods = Math.min(range.vertex_ranges.length, renderData.cpuVisibilityBuffers.length);
      for (let lodIndex = 0; lodIndex < numLods; lodIndex++) {
        const [start, count] = range.vertex_ranges[lodIndex];
        if (count === 0)
          continue;
        const cpuBuffer = renderData.cpuVisibilityBuffers[lodIndex];
        const gpuBuffer = renderData.lodVisibilityBuffers?.[lodIndex];
        if (!cpuBuffer || !gpuBuffer)
          continue;
        if (start + count > cpuBuffer.length)
          continue;
        for (let i = 0; i < count; i++) {
          cpuBuffer[start + i] = 1;
        }
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
  // ==================== DRC Overlay Methods ====================
  /**
   * Load DRC regions and create GPU buffers for overlay rendering
   */
  loadDrcRegions(regions) {
    this.drcRegions = regions;
    this.drcCurrentIndex = 0;
    if (this.drcVertexBuffer) {
      this.drcVertexBuffer.destroy();
      this.drcVertexBuffer = null;
    }
    if (!this.device || regions.length === 0) {
      this.drcEnabled = false;
      return;
    }
    console.log(`[DRC] Loading ${regions.length} DRC regions`);
    this.updateDrcBufferForRegion(this.drcCurrentIndex);
    this.drcEnabled = true;
    this.state.needsDraw = true;
  }
  /**
   * Update GPU buffer for a specific DRC region
   */
  updateDrcBufferForRegion(index) {
    if (!this.device || index < 0 || index >= this.drcRegions.length) {
      this.drcTriangleCount = 0;
      return;
    }
    const region = this.drcRegions[index];
    const vertices = new Float32Array(region.triangle_vertices);
    if (this.drcVertexBuffer) {
      this.drcVertexBuffer.destroy();
    }
    this.drcVertexBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(this.drcVertexBuffer.getMappedRange()).set(vertices);
    this.drcVertexBuffer.unmap();
    this.drcTriangleCount = region.triangle_count;
  }
  /**
   * Navigate to a specific DRC region
   * Returns the region for camera fitting
   */
  navigateToDrcRegion(index) {
    if (index < 0 || index >= this.drcRegions.length) {
      return null;
    }
    this.drcCurrentIndex = index;
    this.updateDrcBufferForRegion(index);
    this.state.needsDraw = true;
    return this.drcRegions[index];
  }
  /**
   * Go to next DRC region (with wrap-around)
   */
  nextDrcRegion() {
    if (this.drcRegions.length === 0)
      return null;
    const nextIndex = (this.drcCurrentIndex + 1) % this.drcRegions.length;
    return this.navigateToDrcRegion(nextIndex);
  }
  /**
   * Go to previous DRC region (with wrap-around)
   */
  prevDrcRegion() {
    if (this.drcRegions.length === 0)
      return null;
    const prevIndex = (this.drcCurrentIndex - 1 + this.drcRegions.length) % this.drcRegions.length;
    return this.navigateToDrcRegion(prevIndex);
  }
  /**
   * Clear DRC overlay
   */
  clearDrc() {
    this.drcEnabled = false;
    this.drcRegions = [];
    this.drcCurrentIndex = 0;
    this.drcTriangleCount = 0;
    if (this.drcVertexBuffer) {
      this.drcVertexBuffer.destroy();
      this.drcVertexBuffer = null;
    }
    this.state.needsDraw = true;
  }
  /**
   * Get current DRC region
   */
  getCurrentDrcRegion() {
    if (this.drcCurrentIndex < 0 || this.drcCurrentIndex >= this.drcRegions.length) {
      return null;
    }
    return this.drcRegions[this.drcCurrentIndex];
  }
  // ==================== End DRC Overlay Methods ====================
  // Map obj_type from ObjectRange to shader key
  // obj_type: 0=Polyline, 1=Polygon, 2=Via, 3=Pad
  getShaderKey(objType) {
    switch (objType) {
      case 0:
        return "batch";
      case 1:
        return "batch_colored";
      case 2:
        return "instanced";
      case 3:
        return "instanced_rot";
      default:
        return null;
    }
  }
  hashStr(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  STORAGE_KEY = "layerColorOverrides";
  saveColorOverride(layerId, color) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      stored[layerId] = color;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      console.error("Failed to save color override", error);
    }
  }
  removeColorOverride(layerId) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      delete stored[layerId];
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      console.error("Failed to remove color override", error);
    }
  }
  loadColorOverrides() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      for (const [layerId, color] of Object.entries(stored)) {
        if (Array.isArray(color) && color.length === 4) {
          this.colorOverrides.set(layerId, [...color]);
          this.layerColors.set(layerId, [...color]);
        }
      }
    } catch (error) {
      console.error("Failed to load color overrides", error);
    }
  }
};

// webview/src/shaders/basic.wgsl?raw
var basic_default = "// Basic shader for rendering simple shapes with optional per-vertex alpha\r\n// Supports lines, arcs, outlines, polygons, polylines, fills\r\n// Consolidated from: line.wgsl, arc.wgsl, outline.wgsl, polygon.wgsl, polyline.wgsl\r\n// Alpha defaults to 1.0 (layer color) when no alpha buffer is provided\r\n// Added: visibility buffer support\r\n\r\nstruct VSOut {\r\n  @builtin(position) Position : vec4<f32>,\r\n  @location(0) color : vec4<f32>,\r\n};\r\n\r\nstruct Uniforms {\r\n  color : vec4<f32>,\r\n  m0 : vec4<f32>,\r\n  m1 : vec4<f32>,\r\n  m2 : vec4<f32>,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> U : Uniforms;\r\n\r\n@vertex\r\nfn vs_main(@location(0) pos : vec2<f32>, @location(1) vertAlpha : f32, @location(2) visibility : f32) -> VSOut {\r\n  var out : VSOut;\r\n  \r\n  if (visibility < 0.5) {\r\n    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);\r\n    out.color = vec4<f32>(0.0);\r\n    return out;\r\n  }\r\n  \r\n  let p = vec3<f32>(pos, 1.0);\r\n  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );\r\n  out.Position = vec4<f32>(t.xy, 0.0, 1.0);\r\n  \r\n  // Check for highlight state (visibility > 1.5)\r\n  if (visibility > 1.5) {\r\n    // Highlighted: blend color towards white (80% white for high visibility)\r\n    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);\r\n    out.color = vec4<f32>(highlightColor, vertAlpha);\r\n  } else {\r\n    // Normal: Combine layer RGB (from uniform) with per-vertex alpha\r\n    out.color = vec4<f32>(U.color.xyz, vertAlpha);\r\n  }\r\n  return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in : VSOut) -> @location(0) vec4<f32> {\r\n  return in.color;\r\n}\r\n";

// webview/src/shaders/basic_noalpha.wgsl?raw
var basic_noalpha_default = "// Basic shader without per-vertex alpha (always uses layer color alpha)\r\n// For rendering polylines and shapes that don't need transparency variation\r\n// Optimized: no alpha buffer required, saves memory and attribute fetching\r\n// Added: visibility buffer support\r\n\r\nstruct VSOut {\r\n  @builtin(position) Position : vec4<f32>,\r\n  @location(0) color : vec4<f32>,\r\n};\r\n\r\nstruct Uniforms {\r\n  color : vec4<f32>,\r\n  m0 : vec4<f32>,\r\n  m1 : vec4<f32>,\r\n  m2 : vec4<f32>,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> U : Uniforms;\r\n\r\n@vertex\r\nfn vs_main(@location(0) pos : vec2<f32>, @location(1) visibility : f32) -> VSOut {\r\n  var out : VSOut;\r\n  \r\n  if (visibility < 0.5) {\r\n    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);\r\n    out.color = vec4<f32>(0.0);\r\n    return out;\r\n  }\r\n  \r\n  let p = vec3<f32>(pos, 1.0);\r\n  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );\r\n  out.Position = vec4<f32>(t.xy, 0.0, 1.0);\r\n  \r\n  // Check for highlight state (visibility > 1.5)\r\n  if (visibility > 1.5) {\r\n    // Highlighted: blend color towards white (80% white for high visibility)\r\n    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);\r\n    out.color = vec4<f32>(highlightColor, U.color.a);\r\n  } else {\r\n    // Use layer color directly (RGB + A from uniform)\r\n    out.color = U.color;\r\n  }\r\n  return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in : VSOut) -> @location(0) vec4<f32> {\r\n  return in.color;\r\n}\r\n";

// webview/src/shaders/instanced.wgsl?raw
var instanced_default = "// Instanced shader for rendering repeated identical geometry at different positions.\r\n// Supports per-instance translation offset and visibility.\r\n// Instance data: vec3<f32> = (offsetX, offsetY, packedVisibility)\r\n\r\nstruct VSOut {\r\n  @builtin(position) Position : vec4<f32>,\r\n  @location(0) color : vec4<f32>,\r\n};\r\n\r\nstruct Uniforms {\r\n  color : vec4<f32>,\r\n  m0 : vec4<f32>,\r\n  m1 : vec4<f32>,\r\n  m2 : vec4<f32>,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> U : Uniforms;\r\n\r\n@vertex\r\nfn vs_main(@location(0) pos : vec2<f32>, @location(1) inst : vec3<f32>) -> VSOut {\r\n  var out : VSOut;\r\n  \r\n  // Unpack visibility and highlight (rotation is ignored for this shader)\r\n  let packed = bitcast<u32>(inst.z);\r\n  let visible = (packed & 1u) != 0u;\r\n  let highlighted = (packed & 2u) != 0u;\r\n  \r\n  if (!visible) {\r\n    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);\r\n    out.color = vec4<f32>(0.0);\r\n    return out;\r\n  }\r\n  \r\n  let p = vec3<f32>(pos + inst.xy, 1.0);\r\n  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );\r\n  out.Position = vec4<f32>(t.xy, 0.0, 1.0);\r\n  \r\n  if (highlighted) {\r\n    // Highlighted: blend color towards white (80% white for high visibility)\r\n    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);\r\n    out.color = vec4<f32>(highlightColor, U.color.a);\r\n  } else {\r\n    out.color = U.color;\r\n  }\r\n  return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in : VSOut) -> @location(0) vec4<f32> {\r\n  return in.color;\r\n}\r\n";

// webview/src/shaders/instanced_rot.wgsl?raw
var instanced_rot_default = "// Instanced shader with rotation support.\r\n// For rendering repeated geometry at different positions with arbitrary rotations.\r\n// Instance data: vec3<f32> = (offsetX, offsetY, packedRotationVisibility)\r\n// Packed format: [16-bit angle][15-bit unused][1-bit visibility]\r\n\r\nstruct VSOut {\r\n  @builtin(position) Position : vec4<f32>,\r\n  @location(0) color : vec4<f32>,\r\n};\r\n\r\nstruct Uniforms {\r\n  color : vec4<f32>,\r\n  m0 : vec4<f32>,\r\n  m1 : vec4<f32>,\r\n  m2 : vec4<f32>,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> U : Uniforms;\r\n\r\n@vertex\r\nfn vs_main(@location(0) pos : vec2<f32>, @location(1) inst : vec3<f32>) -> VSOut {\r\n  var out : VSOut;\r\n  \r\n  // Unpack rotation, visibility, and highlight\r\n  let packed = bitcast<u32>(inst.z);\r\n  let visible = (packed & 1u) != 0u;\r\n  let highlighted = (packed & 2u) != 0u;\r\n  \r\n  if (!visible) {\r\n    // Discard vertex by moving it outside clip space\r\n    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);\r\n    out.color = vec4<f32>(0.0);\r\n    return out;\r\n  }\r\n  \r\n  let angle_u16 = packed >> 16u;\r\n  let angle_normalized = f32(angle_u16) / 65535.0;\r\n  let angle = angle_normalized * 6.28318530718; // 2 * PI\r\n  \r\n  let c = cos(angle);\r\n  let s = sin(angle);\r\n  \r\n  // Apply rotation\r\n  let rotated = vec2<f32>(\r\n    pos.x * c - pos.y * s,\r\n    pos.x * s + pos.y * c\r\n  );\r\n  \r\n  // Apply translation and transform\r\n  let p = vec3<f32>(rotated + inst.xy, 1.0);\r\n  let t = vec3<f32>( dot(U.m0.xyz, p), dot(U.m1.xyz, p), dot(U.m2.xyz, p) );\r\n  out.Position = vec4<f32>(t.xy, 0.0, 1.0);\r\n  \r\n  if (highlighted) {\r\n    // Highlighted: blend color towards white (80% white for high visibility)\r\n    let highlightColor = mix(U.color.xyz, vec3<f32>(1.0, 1.0, 1.0), 0.8);\r\n    out.color = vec4<f32>(highlightColor, U.color.a);\r\n  } else {\r\n    out.color = U.color;\r\n  }\r\n  return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in : VSOut) -> @location(0) vec4<f32> {\r\n  return in.color;\r\n}\r\n";

// webview/src/shaders/drc_overlay.wgsl?raw
var drc_overlay_default = "// DRC Overlay shader - bright red diagonal stripes over violation triangles\r\n\r\nstruct ViewMat {\r\n  v0 : vec4<f32>,\r\n  v1 : vec4<f32>,\r\n  v2 : vec4<f32>,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> VIEW : ViewMat;\r\n\r\nstruct VSOut {\r\n  @builtin(position) Position : vec4<f32>,\r\n  @location(0) worldPos : vec2<f32>,\r\n};\r\n\r\n@vertex\r\nfn vs_main(@location(0) pos : vec2<f32>) -> VSOut {\r\n  var out : VSOut;\r\n  \r\n  // Apply view transform\r\n  let p = vec3<f32>(pos, 1.0);\r\n  let v = vec3<f32>(\r\n    dot(VIEW.v0.xyz, p),\r\n    dot(VIEW.v1.xyz, p),\r\n    dot(VIEW.v2.xyz, p)\r\n  );\r\n  \r\n  out.Position = vec4<f32>(v.xy, 0.1, 1.0); // z=0.1 to draw on top\r\n  out.worldPos = pos;\r\n  \r\n  return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in : VSOut) -> @location(0) vec4<f32> {\r\n  // Create diagonal stripe pattern\r\n  // Scale pattern based on world coordinates for consistent appearance\r\n  let stripeWidth = 0.1; // 0.1mm stripe width\r\n  let stripeSpacing = 0.2; // 0.2mm between stripes\r\n  let period = stripeWidth + stripeSpacing;\r\n  \r\n  // Diagonal stripe: x + y creates 45-degree angle\r\n  let diag = (in.worldPos.x + in.worldPos.y);\r\n  let stripe = fract(diag / period);\r\n  \r\n  // Bright red color with pulsing alpha for visibility\r\n  let baseColor = vec3<f32>(1.0, 0.1, 0.1);\r\n  \r\n  // Create stripe pattern - 1.0 in stripe, 0.0 outside\r\n  let inStripe = step(stripe, stripeWidth / period);\r\n  \r\n  // Semi-transparent overlay\r\n  let alpha = inStripe * 0.75;\r\n  \r\n  // Discard fragments outside stripes for better performance\r\n  if (alpha < 0.01) {\r\n    discard;\r\n  }\r\n  \r\n  return vec4<f32>(baseColor, alpha);\r\n}\r\n";

// webview/src/Renderer.ts
var Renderer = class {
  canvas;
  device;
  context;
  pipelineNoAlpha;
  pipelineWithAlpha;
  pipelineInstanced;
  pipelineInstancedRot;
  pipelineDrcOverlay;
  canvasFormat;
  configuredWidth = 0;
  configuredHeight = 0;
  uniformData = new Float32Array(16);
  // DRC overlay bind group and uniform buffer
  drcUniformBuffer;
  drcBindGroup;
  lastVertexCount = 0;
  lastIndexCount = 0;
  frameCount = 0;
  lastFpsUpdate = performance.now();
  lastFps = 0;
  scene;
  // Debug stats
  gpuMemoryBytes = 0;
  gpuBuffers = [];
  // Debug control
  debugRenderType = "all";
  debugLogNextFrame = false;
  // Loading state - keep canvas black until first layer batch is loaded
  isLoading = true;
  constructor(canvas, scene) {
    this.canvas = canvas;
    this.scene = scene;
  }
  async init() {
    const gpu = navigator.gpu;
    if (!gpu) {
      throw new Error("WebGPU is not available in this browser");
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Unable to acquire WebGPU adapter");
    }
    this.device = await adapter.requestDevice();
    this.wrapCreateBuffer(this.device);
    const ctx = this.canvas.getContext("webgpu");
    if (!ctx) {
      throw new Error("Failed to acquire WebGPU context");
    }
    this.context = ctx;
    this.canvasFormat = gpu.getPreferredCanvasFormat();
    this.createPipelines();
    this.scene.setDevice(this.device, {
      noAlpha: this.pipelineNoAlpha,
      withAlpha: this.pipelineWithAlpha,
      instanced: this.pipelineInstanced,
      instancedRot: this.pipelineInstancedRot
    });
    const resizeObserver = new ResizeObserver(() => {
      this.configureSurface();
      this.scene.state.needsDraw = true;
    });
    resizeObserver.observe(this.canvas);
    window.addEventListener("resize", () => {
      this.configureSurface();
      this.scene.state.needsDraw = true;
    });
  }
  createPipelines() {
    const shaderModuleWithAlpha = this.device.createShaderModule({ code: basic_default });
    const shaderModuleNoAlpha = this.device.createShaderModule({ code: basic_noalpha_default });
    const shaderModuleInstanced = this.device.createShaderModule({ code: instanced_default });
    const shaderModuleInstancedRot = this.device.createShaderModule({ code: instanced_rot_default });
    this.pipelineWithAlpha = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModuleWithAlpha,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          },
          {
            arrayStride: 1 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }]
          },
          {
            // Visibility buffer
            arrayStride: 1 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 2, offset: 0, format: "float32" }]
          }
        ]
      },
      fragment: {
        module: shaderModuleWithAlpha,
        entryPoint: "fs_main",
        targets: [{
          format: this.canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.pipelineNoAlpha = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModuleNoAlpha,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          },
          {
            // Visibility buffer
            arrayStride: 1 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }]
          }
        ]
      },
      fragment: {
        module: shaderModuleNoAlpha,
        entryPoint: "fs_main",
        targets: [{
          format: this.canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.pipelineInstanced = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModuleInstanced,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          },
          {
            arrayStride: 3 * Float32Array.BYTES_PER_ELEMENT,
            // Changed to 3 floats (x, y, packed)
            stepMode: "instance",
            attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }]
          }
        ]
      },
      fragment: {
        module: shaderModuleInstanced,
        entryPoint: "fs_main",
        targets: [{
          format: this.canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.pipelineInstancedRot = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModuleInstancedRot,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          },
          {
            arrayStride: 3 * Float32Array.BYTES_PER_ELEMENT,
            stepMode: "instance",
            attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }]
          }
        ]
      },
      fragment: {
        module: shaderModuleInstancedRot,
        entryPoint: "fs_main",
        targets: [{
          format: this.canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    const shaderModuleDrcOverlay = this.device.createShaderModule({ code: drc_overlay_default });
    this.pipelineDrcOverlay = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModuleDrcOverlay,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          }
        ]
      },
      fragment: {
        module: shaderModuleDrcOverlay,
        entryPoint: "fs_main",
        targets: [{
          format: this.canvasFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
          }
        }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.drcUniformBuffer = this.device.createBuffer({
      size: 48,
      // 3 x vec4<f32> for view matrix
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.drcBindGroup = this.device.createBindGroup({
      layout: this.pipelineDrcOverlay.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.drcUniformBuffer }
      }]
    });
  }
  wrapCreateBuffer(gpuDevice) {
    if (gpuDevice.__wrappedCreateBuffer) {
      return;
    }
    const original = gpuDevice.createBuffer.bind(gpuDevice);
    gpuDevice.createBuffer = (descriptor) => {
      const buffer = original(descriptor);
      const size = descriptor.size ?? 0;
      this.gpuMemoryBytes += size;
      const bufferInfo = { buffer, size };
      this.gpuBuffers.push(bufferInfo);
      const originalDestroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        const index = this.gpuBuffers.indexOf(bufferInfo);
        if (index !== -1) {
          this.gpuMemoryBytes -= size;
          this.gpuBuffers.splice(index, 1);
        }
        originalDestroy();
      };
      return buffer;
    };
    gpuDevice.__wrappedCreateBuffer = true;
  }
  configureSurface() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width)
      this.canvas.width = width;
    if (this.canvas.height !== height)
      this.canvas.height = height;
    if (width === this.configuredWidth && height === this.configuredHeight) {
      return;
    }
    this.configuredWidth = width;
    this.configuredHeight = height;
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
  }
  updateUniforms() {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    const flipX = state.flipX ? -1 : 1;
    const flipY = state.flipY ? -1 : 1;
    const scaleX = 2 * state.zoom / width;
    const scaleY = 2 * state.zoom / height;
    const offsetX = scaleX * (width / 2 + state.panX) - 1;
    const offsetY = 1 - scaleY * (height / 2 + state.panY);
    this.uniformData[4] = flipX * scaleX;
    this.uniformData[5] = 0;
    this.uniformData[6] = flipX * offsetX;
    this.uniformData[7] = 0;
    this.uniformData[8] = 0;
    this.uniformData[9] = flipY * -scaleY;
    this.uniformData[10] = flipY > 0 ? offsetY : -offsetY;
    this.uniformData[11] = 0;
    this.uniformData[12] = 0;
    this.uniformData[13] = 0;
    this.uniformData[14] = 1;
    this.uniformData[15] = 0;
  }
  selectLODForZoom(zoom) {
    if (zoom >= 10)
      return 0;
    if (zoom >= 5)
      return 1;
    if (zoom >= 2)
      return 2;
    if (zoom >= 0.5)
      return 3;
    return 4;
  }
  screenToWorld(cssX, cssY) {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    const fx = state.flipX ? -1 : 1;
    const fy = state.flipY ? -1 : 1;
    const scaleX = 2 * state.zoom / width;
    const scaleY = 2 * state.zoom / height;
    const xNdc = 2 * cssX / Math.max(1, this.canvas.clientWidth) - 1;
    const yNdc = 1 - 2 * cssY / Math.max(1, this.canvas.clientHeight);
    const worldX = (xNdc / fx + 1) / scaleX - width / 2 - state.panX;
    const worldY = (1 - yNdc * fy) / scaleY - height / 2 - state.panY;
    return { x: worldX, y: worldY };
  }
  worldToScreen(worldX, worldY) {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    const fx = state.flipX ? -1 : 1;
    const fy = state.flipY ? -1 : 1;
    const scaleX = 2 * state.zoom / width;
    const scaleY = 2 * state.zoom / height;
    const xNdc = ((worldX + width / 2 + state.panX) * scaleX - 1) * fx;
    const yNdc = (1 - (worldY + height / 2 + state.panY) * scaleY) / fy;
    const cssX = (xNdc + 1) * Math.max(1, this.canvas.clientWidth) / 2;
    const cssY = (1 - yNdc) * Math.max(1, this.canvas.clientHeight) / 2;
    return { x: cssX, y: cssY };
  }
  render() {
    if (!this.scene.state.needsDraw) {
      return;
    }
    this.scene.state.needsDraw = false;
    this.configureSurface();
    this.updateUniforms();
    if (window.debugRenderType) {
      this.debugRenderType = window.debugRenderType;
    }
    if (window.debugLogNextFrame) {
      this.debugLogNextFrame = true;
      window.debugLogNextFrame = false;
    }
    const currentLOD = this.selectLODForZoom(this.scene.state.zoom);
    if (this.debugLogNextFrame) {
      console.log(`[Render] Frame start. Zoom: ${this.scene.state.zoom}, LOD: ${currentLOD}`);
    }
    const encoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    let totalVertices = 0;
    let totalIndices = 0;
    if (this.isLoading) {
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return;
    }
    for (const layerId of this.scene.layerOrder) {
      if (this.scene.layerVisible.get(layerId) === false)
        continue;
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        if (data.layerId !== layerId)
          continue;
        if (this.debugRenderType !== "all") {
          if (this.debugRenderType === "batch" && data.shaderType !== "batch" && data.shaderType !== "batch_colored")
            continue;
          if (this.debugRenderType === "instanced" && data.shaderType !== "instanced")
            continue;
          if (this.debugRenderType === "instanced_rot" && data.shaderType !== "instanced_rot")
            continue;
        }
        if (data.shaderType === "instanced" || data.shaderType === "instanced_rot") {
          const totalLODs = data.lodBuffers.length;
          const numShapes = totalLODs / 3;
          const effectiveLOD = Math.min(currentLOD, 2);
          const lodStartIdx = effectiveLOD * numShapes;
          const lodEndIdx = lodStartIdx + numShapes;
          const pipeline = data.shaderType === "instanced_rot" ? this.pipelineInstancedRot : this.pipelineInstanced;
          pass.setPipeline(pipeline);
          for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
            const vb2 = data.lodBuffers[idx];
            const count2 = data.lodVertexCounts[idx];
            const instanceBuf = data.lodInstanceBuffers?.[idx];
            const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
            if (!vb2 || !count2 || !instanceBuf || instanceCount === 0)
              continue;
            if (this.debugLogNextFrame) {
              console.log(`[Render] Drawing instanced ${data.shaderType} layer=${layerId} idx=${idx} verts=${count2} instances=${instanceCount}`);
            }
            pass.setVertexBuffer(0, vb2);
            pass.setVertexBuffer(1, instanceBuf);
            const layerColor2 = this.scene.getLayerColor(data.layerId);
            this.uniformData.set(layerColor2, 0);
            this.device.queue.writeBuffer(data.uniformBuffer, 0, this.uniformData);
            pass.setBindGroup(0, data.bindGroup);
            const ib2 = data.lodIndexBuffers?.[idx];
            const ic2 = data.lodIndexCounts?.[idx] ?? 0;
            if (ib2 && ic2 > 0) {
              pass.setIndexBuffer(ib2, "uint32");
              pass.drawIndexed(ic2, instanceCount);
              totalIndices += ic2 * instanceCount;
            } else {
              pass.draw(count2, instanceCount);
            }
          }
          continue;
        }
        const actualLOD = Math.min(currentLOD, data.lodBuffers.length - 1);
        const vb = data.lodBuffers[actualLOD];
        const count = data.lodVertexCounts[actualLOD];
        if (!vb || !count)
          continue;
        totalVertices += count;
        if (this.debugLogNextFrame) {
          console.log(`[Render] Drawing batch ${data.shaderType} layer=${layerId} LOD=${actualLOD} verts=${count}`);
        }
        let usePipeline;
        if (data.shaderType === "batch") {
          usePipeline = this.pipelineNoAlpha;
        } else {
          usePipeline = this.pipelineWithAlpha;
        }
        pass.setPipeline(usePipeline);
        pass.setVertexBuffer(0, vb);
        if (data.shaderType !== "batch") {
          const alphaBuf = data.lodAlphaBuffers[actualLOD];
          if (alphaBuf) {
            pass.setVertexBuffer(1, alphaBuf);
          }
          const visBuf = data.lodVisibilityBuffers[actualLOD];
          if (visBuf) {
            pass.setVertexBuffer(2, visBuf);
            if (this.debugLogNextFrame && data.layerId === "Mechanical 9") {
              console.log(`[Render] Binding visibility buffer to slot 2 for ${data.layerId}, LOD${actualLOD}`);
            }
          } else if (this.debugLogNextFrame && data.layerId === "Mechanical 9") {
            console.log(`[Render] NO visibility buffer for ${data.layerId}, LOD${actualLOD}`);
          }
        } else {
          const visBuf = data.lodVisibilityBuffers[actualLOD];
          if (visBuf) {
            pass.setVertexBuffer(1, visBuf);
            if (this.debugLogNextFrame && data.layerId === "Mechanical 9") {
              console.log(`[Render] Binding visibility buffer to slot 1 for ${data.layerId}, LOD${actualLOD}`);
            }
          } else if (this.debugLogNextFrame && data.layerId === "Mechanical 9") {
            console.log(`[Render] NO visibility buffer for ${data.layerId}, LOD${actualLOD}`);
          }
        }
        const layerColor = this.scene.getLayerColor(data.layerId);
        this.uniformData.set(layerColor, 0);
        this.device.queue.writeBuffer(data.uniformBuffer, 0, this.uniformData);
        pass.setBindGroup(0, data.bindGroup);
        const ib = data.lodIndexBuffers?.[actualLOD] ?? null;
        const ic = data.lodIndexCounts?.[actualLOD] ?? 0;
        if (ib && ic > 0) {
          pass.setIndexBuffer(ib, "uint32");
          pass.drawIndexed(ic);
          totalIndices += ic;
        } else {
          pass.draw(count);
        }
      }
    }
    const anyLayerVisible = Array.from(this.scene.layerVisible.values()).some((v) => v);
    if (this.scene.viasVisible && anyLayerVisible) {
      const viaColor = [1, 0.84, 0, 1];
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        if (data.shaderType !== "instanced")
          continue;
        if (this.scene.layerVisible.get(data.layerId) === false)
          continue;
        const totalLODs = data.lodBuffers.length;
        const numShapes = totalLODs / 3;
        const effectiveLOD = Math.min(currentLOD, 2);
        const lodStartIdx = effectiveLOD * numShapes;
        const lodEndIdx = lodStartIdx + numShapes;
        pass.setPipeline(this.pipelineInstanced);
        for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
          const vb = data.lodBuffers[idx];
          const count = data.lodVertexCounts[idx];
          if (!vb || !count || count === 0)
            continue;
          const instanceBuf = data.lodInstanceBuffers?.[idx];
          const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
          if (!instanceBuf || instanceCount === 0)
            continue;
          pass.setVertexBuffer(0, vb);
          pass.setVertexBuffer(1, instanceBuf);
          this.uniformData.set(viaColor, 0);
          this.device.queue.writeBuffer(data.uniformBuffer, 0, this.uniformData);
          pass.setBindGroup(0, data.bindGroup);
          const ib = data.lodIndexBuffers?.[idx] ?? null;
          const ic = data.lodIndexCounts?.[idx] ?? 0;
          if (ib && ic > 0) {
            pass.setIndexBuffer(ib, "uint32");
            pass.drawIndexed(ic, instanceCount);
          } else {
            pass.draw(count, instanceCount);
          }
        }
      }
    }
    if (this.scene.drcEnabled && this.scene.drcVertexBuffer && this.scene.drcTriangleCount > 0) {
      this.device.queue.writeBuffer(this.drcUniformBuffer, 0, this.uniformData.subarray(4, 16));
      pass.setPipeline(this.pipelineDrcOverlay);
      pass.setBindGroup(0, this.drcBindGroup);
      pass.setVertexBuffer(0, this.scene.drcVertexBuffer);
      pass.draw(this.scene.drcTriangleCount * 3);
      if (this.debugLogNextFrame) {
        console.log(`[Render] DRC overlay: ${this.scene.drcTriangleCount} triangles`);
      }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.lastVertexCount = totalVertices;
    this.lastIndexCount = totalIndices;
    if (this.debugLogNextFrame) {
      console.log(`[Render] Frame end. Total verts: ${totalVertices}, indices: ${totalIndices}`);
      this.debugLogNextFrame = false;
    }
    this.frameCount += 1;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1e3) {
      this.lastFps = this.frameCount * 1e3 / (now - this.lastFpsUpdate);
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }
  /**
   * Mark loading as complete - allows rendering to begin
   */
  finishLoading() {
    this.isLoading = false;
    this.scene.state.needsDraw = true;
  }
  /**
   * Fit the camera to show a bounding box with some padding
   */
  fitToBounds(bounds, padding = 0.2) {
    const [minX, minY, maxX, maxY] = bounds;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 0 || height <= 0)
      return;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const canvasWidth = this.canvas.clientWidth;
    const canvasHeight = this.canvas.clientHeight;
    const zoomX = canvasWidth * (1 - padding) / width;
    const zoomY = canvasHeight * (1 - padding) / height;
    const zoom = Math.min(zoomX, zoomY);
    const state = this.scene.state;
    state.zoom = zoom;
    state.panX = -(centerX - canvasWidth / 2);
    state.panY = -(centerY - canvasHeight / 2);
    state.needsDraw = true;
  }
};

// webview/src/UI.ts
var UI = class {
  scene;
  renderer;
  debugOverlay = null;
  layersEl = null;
  coordOverlayEl = null;
  fpsEl = null;
  debugLogEl = null;
  lastStatsUpdate = 0;
  rustMemoryBytes = null;
  highlightBox;
  contextMenu;
  currentHighlightBounds = null;
  onDelete = null;
  // DRC UI elements
  drcPanel = null;
  drcCountLabel = null;
  drcInfoLabel = null;
  onRunDrc = null;
  onDrcNavigate = null;
  onClearDrc = null;
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.layersEl = document.getElementById("layers");
    this.coordOverlayEl = document.getElementById("coordOverlay");
    this.fpsEl = document.getElementById("fps");
    this.debugLogEl = document.getElementById("debugLog");
    this.addDebugCoordsCheckbox();
    this.highlightBox = document.createElement("div");
    this.highlightBox.style.position = "absolute";
    this.highlightBox.style.pointerEvents = "none";
    this.highlightBox.style.display = "none";
    this.highlightBox.style.zIndex = "999";
    this.contextMenu = document.createElement("div");
    this.contextMenu.style.position = "fixed";
    this.contextMenu.style.background = "#252526";
    this.contextMenu.style.border = "1px solid #454545";
    this.contextMenu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.5)";
    this.contextMenu.style.padding = "4px 0";
    this.contextMenu.style.display = "none";
    this.contextMenu.style.zIndex = "10000";
    this.contextMenu.style.minWidth = "120px";
    const deleteOption = document.createElement("div");
    deleteOption.textContent = "Delete";
    deleteOption.style.padding = "6px 12px";
    deleteOption.style.cursor = "pointer";
    deleteOption.style.color = "#cccccc";
    deleteOption.style.fontSize = "13px";
    deleteOption.style.fontFamily = "Segoe UI, sans-serif";
    deleteOption.addEventListener("mouseenter", () => {
      deleteOption.style.backgroundColor = "#094771";
      deleteOption.style.color = "#ffffff";
    });
    deleteOption.addEventListener("mouseleave", () => {
      deleteOption.style.backgroundColor = "transparent";
      deleteOption.style.color = "#cccccc";
    });
    deleteOption.addEventListener("click", () => {
      if (this.onDelete) {
        this.onDelete();
      }
      this.contextMenu.style.display = "none";
    });
    this.contextMenu.appendChild(deleteOption);
    document.body.appendChild(this.contextMenu);
    if (this.renderer.canvas.parentElement) {
      this.renderer.canvas.parentElement.style.position = "relative";
      this.renderer.canvas.parentElement.appendChild(this.highlightBox);
    } else {
      document.body.appendChild(this.highlightBox);
    }
    document.addEventListener("contextmenu", (e) => {
      if (this.currentHighlightBounds) {
        e.preventDefault();
        console.log("[UI] Opening context menu at", e.clientX, e.clientY);
        this.contextMenu.style.display = "block";
        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
      } else {
        console.log("[UI] Context menu ignored - no selection");
      }
    });
    document.addEventListener("click", (e) => {
      if (this.contextMenu.style.display === "block" && !this.contextMenu.contains(e.target)) {
        this.contextMenu.style.display = "none";
      }
    });
    this.interceptConsoleLog(this.debugLogEl);
    this.createDebugControls();
  }
  setOnDelete(callback) {
    this.onDelete = callback;
  }
  highlightObject(bounds) {
    this.currentHighlightBounds = bounds;
    this.updateHighlightPosition();
  }
  updateHighlightPosition() {
    if (!this.currentHighlightBounds)
      return;
    const [minX, minY, maxX, maxY] = this.currentHighlightBounds;
    const p1 = this.renderer.worldToScreen(minX, minY);
    const p2 = this.renderer.worldToScreen(maxX, maxY);
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const width = Math.abs(p2.x - p1.x);
    const height = Math.abs(p2.y - p1.y);
    this.highlightBox.style.display = "block";
    this.highlightBox.style.left = `${left}px`;
    this.highlightBox.style.top = `${top}px`;
    this.highlightBox.style.width = `${width}px`;
    this.highlightBox.style.height = `${height}px`;
  }
  clearHighlight() {
    this.currentHighlightBounds = null;
    this.highlightBox.style.display = "none";
  }
  createDebugControls() {
    if (!this.layersEl)
      return;
    const debugContainer = document.createElement("div");
    debugContainer.style.marginTop = "10px";
    debugContainer.style.borderTop = "1px solid #444";
    debugContainer.style.paddingTop = "5px";
    debugContainer.style.pointerEvents = "auto";
    debugContainer.innerHTML = `
      <div style="margin-bottom: 5px; font-weight: bold;">Debug Render</div>
      <select id="debugRenderType" style="width: 100%; background: #333; color: white; border: 1px solid #555; margin-bottom: 5px;">
        <option value="all">All Geometry</option>
        <option value="batch">Polylines Only (Batch)</option>
        <option value="instanced">Vias Only (Instanced)</option>
        <option value="instanced_rot">Pads Only (InstancedRot)</option>
      </select>
      <button id="debugLogFrame" style="width: 100%; background: #444; color: white; border: 1px solid #555; cursor: pointer;">Log Next Frame</button>
    `;
    this.layersEl.parentElement?.insertBefore(debugContainer, this.layersEl.nextSibling);
    const select = debugContainer.querySelector("#debugRenderType");
    select.addEventListener("change", (e) => {
      const val = e.target.value;
      this.renderer.debugRenderType = val;
      this.scene.state.needsDraw = true;
    });
    const btn = debugContainer.querySelector("#debugLogFrame");
    btn.addEventListener("click", () => {
      this.renderer.debugLogNextFrame = true;
      this.scene.state.needsDraw = true;
      console.log("Next frame will be logged to console...");
    });
    this.createDrcPanel(debugContainer);
  }
  createDrcPanel(afterElement) {
    this.drcPanel = document.createElement("div");
    this.drcPanel.style.marginTop = "10px";
    this.drcPanel.style.borderTop = "1px solid #444";
    this.drcPanel.style.paddingTop = "5px";
    this.drcPanel.style.pointerEvents = "auto";
    this.drcPanel.innerHTML = `
      <div style="margin-bottom: 5px; font-weight: bold; color: #ff6b6b;">\u26A0\uFE0F DRC Violations</div>
      <button id="runDrcBtn" style="width: 100%; background: #ff4444; color: white; border: 1px solid #cc3333; padding: 6px; margin-bottom: 5px; cursor: pointer; border-radius: 3px;">Run DRC</button>
      <div id="drcInfo" style="margin-bottom: 5px; font-size: 11px; color: #aaa; display: none;">
        <span id="drcCount">0</span> violations found
      </div>
      <div id="drcNavContainer" style="display: none; margin-bottom: 5px;">
        <div style="display: flex; gap: 4px;">
          <button id="drcPrevBtn" style="flex: 1; background: #444; color: white; border: 1px solid #555; padding: 4px; cursor: pointer;">\u25C0 Prev</button>
          <button id="drcNextBtn" style="flex: 1; background: #444; color: white; border: 1px solid #555; padding: 4px; cursor: pointer;">Next \u25B6</button>
        </div>
        <div id="drcViolationInfo" style="margin-top: 5px; font-size: 10px; color: #ccc; background: #2a2a2a; padding: 5px; border-radius: 3px;"></div>
      </div>
      <button id="clearDrcBtn" style="width: 100%; background: #333; color: #aaa; border: 1px solid #555; padding: 4px; cursor: pointer; display: none;">Clear DRC</button>
    `;
    afterElement.parentElement?.insertBefore(this.drcPanel, afterElement.nextSibling);
    const runBtn = this.drcPanel.querySelector("#runDrcBtn");
    runBtn.addEventListener("click", () => {
      if (this.onRunDrc) {
        runBtn.textContent = "Running...";
        runBtn.disabled = true;
        this.onRunDrc();
      }
    });
    const prevBtn = this.drcPanel.querySelector("#drcPrevBtn");
    prevBtn.addEventListener("click", () => {
      if (this.onDrcNavigate)
        this.onDrcNavigate("prev");
    });
    const nextBtn = this.drcPanel.querySelector("#drcNextBtn");
    nextBtn.addEventListener("click", () => {
      if (this.onDrcNavigate)
        this.onDrcNavigate("next");
    });
    const clearBtn = this.drcPanel.querySelector("#clearDrcBtn");
    clearBtn.addEventListener("click", () => {
      if (this.onClearDrc)
        this.onClearDrc();
    });
    this.drcCountLabel = this.drcPanel.querySelector("#drcCount");
    this.drcInfoLabel = this.drcPanel.querySelector("#drcViolationInfo");
  }
  setOnRunDrc(callback) {
    this.onRunDrc = callback;
  }
  setOnDrcNavigate(callback) {
    this.onDrcNavigate = callback;
  }
  setOnClearDrc(callback) {
    this.onClearDrc = callback;
  }
  updateDrcPanel(regionCount, currentIndex, currentRegion) {
    if (!this.drcPanel)
      return;
    const runBtn = this.drcPanel.querySelector("#runDrcBtn");
    const infoDiv = this.drcPanel.querySelector("#drcInfo");
    const navContainer = this.drcPanel.querySelector("#drcNavContainer");
    const clearBtn = this.drcPanel.querySelector("#clearDrcBtn");
    runBtn.textContent = "Run DRC";
    runBtn.disabled = false;
    if (regionCount > 0) {
      infoDiv.style.display = "block";
      navContainer.style.display = "block";
      clearBtn.style.display = "block";
      if (this.drcCountLabel) {
        this.drcCountLabel.textContent = `${currentIndex + 1} / ${regionCount}`;
      }
      if (this.drcInfoLabel && currentRegion) {
        const netA = currentRegion.net_a || "unnamed";
        const netB = currentRegion.net_b || "unnamed";
        this.drcInfoLabel.innerHTML = `
          <div>Layer: <b>${currentRegion.layer_id}</b></div>
          <div>Distance: <b style="color:#ff6b6b;">${currentRegion.min_distance_mm.toFixed(3)}mm</b> (req: ${currentRegion.clearance_mm.toFixed(3)}mm)</div>
          <div>Nets: <b>${netA}</b> \u2194 <b>${netB}</b></div>
          <div>Triangles: ${currentRegion.triangle_count}</div>
        `;
      }
    } else {
      infoDiv.style.display = "none";
      navContainer.style.display = "none";
      clearBtn.style.display = "none";
    }
  }
  resetDrcPanel() {
    if (!this.drcPanel)
      return;
    const runBtn = this.drcPanel.querySelector("#runDrcBtn");
    runBtn.textContent = "Run DRC";
    runBtn.disabled = false;
    const infoDiv = this.drcPanel.querySelector("#drcInfo");
    const navContainer = this.drcPanel.querySelector("#drcNavContainer");
    const clearBtn = this.drcPanel.querySelector("#clearDrcBtn");
    infoDiv.style.display = "none";
    navContainer.style.display = "none";
    clearBtn.style.display = "none";
  }
  interceptConsoleLog(target) {
    if (!target) {
      return;
    }
    console.log("[LOGGING] Browser DevTools console is the primary log output");
  }
  refreshLayerLegend() {
    if (!this.layersEl) {
      return;
    }
    const legendParts = [];
    legendParts.push(`
      <div style="margin-bottom:4px; display:flex; gap:4px; flex-wrap:wrap; font:11px sans-serif;">
        <button type="button" data-layer-action="all" style="padding:2px 6px;">All</button>
        <button type="button" data-layer-action="none" style="padding:2px 6px;">None</button>
        <button type="button" data-layer-action="invert" style="padding:2px 6px;">Invert</button>
        <button type="button" id="savePcbBtn" style="padding:2px 6px; background:#4a9eff; color:#fff; border:1px solid #3a8eef; border-radius:3px; font-weight:bold;">\u{1F4BE} Save</button>
      </div>
    `);
    const entries = this.scene.layerOrder.map((layerId) => [layerId, this.scene.getLayerColor(layerId)]);
    legendParts.push(`<div>`);
    for (const [layerId, color] of entries) {
      const visible = this.scene.layerVisible.get(layerId) !== false;
      legendParts.push(this.createLegendRow(layerId, color, visible));
    }
    legendParts.push(`</div>`);
    this.layersEl.innerHTML = legendParts.join("");
    this.layersEl.querySelectorAll("button[data-layer-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const action = event.currentTarget.dataset.layerAction;
        if (action === "all") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, true);
          }
        } else if (action === "none") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, false);
          }
        } else if (action === "invert") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, !(this.scene.layerVisible.get(layerId) !== false));
          }
        }
        this.refreshLayerLegend();
        this.scene.state.needsDraw = true;
      });
    });
    this.layersEl.querySelectorAll("input[data-layer-toggle]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const target = event.currentTarget;
        const layerId = target.dataset.layerToggle;
        if (!layerId)
          return;
        this.scene.toggleLayerVisibility(layerId, target.checked);
      });
    });
    this.layersEl.querySelectorAll("button[data-layer-color]").forEach((button) => {
      button.addEventListener("click", () => {
        const layerId = button.dataset.layerColor;
        if (!layerId)
          return;
        const current = this.scene.getLayerColor(layerId);
        this.showColorPicker(layerId, current);
      });
    });
    const saveBtn = document.getElementById("savePcbBtn");
    saveBtn?.addEventListener("click", () => {
      this.handleSave();
    });
  }
  async handleSave() {
    const vscode3 = window.vscode;
    if (!vscode3) {
      console.warn("[SAVE] Save is only available in VS Code extension mode");
      alert("Save is only available when running in VS Code.\n\nTo use save:\n1. Press F5 in VS Code to launch Extension Development Host\n2. Open a PCB file\n3. Click the Save button");
      const saveBtn2 = document.getElementById("savePcbBtn");
      if (saveBtn2) {
        saveBtn2.disabled = false;
        saveBtn2.textContent = "\u{1F4BE} Save";
      }
      return;
    }
    console.log("[SAVE] Requesting save...");
    const saveBtn = document.getElementById("savePcbBtn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "\u{1F4BE} Saving...";
    }
    vscode3.postMessage({ command: "Save" });
  }
  createLegendRow(layerId, color, visible) {
    const rgb = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, 1)`;
    const layer = this.scene.layerInfoMap.get(layerId);
    const label = layer ? layer.name : layerId;
    const checked = visible ? "checked" : "";
    return `
      <div class="layer-entry" data-layer="${layerId}" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <input type="checkbox" data-layer-toggle="${layerId}" ${checked} style="margin:0" />
        <button type="button" data-layer-color="${layerId}" title="Change color" style="width:18px;height:18px;border:1px solid #444;border-radius:3px;background:${rgb};"></button>
        <span style="flex:1 1 auto; font-size:11px;">${label}</span>
      </div>
    `;
  }
  showColorPicker(layerId, currentColor) {
    const existing = document.getElementById("colorPickerModal");
    existing?.remove();
    const modal = document.createElement("div");
    modal.id = "colorPickerModal";
    modal.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000;";
    const picker = document.createElement("div");
    picker.style.cssText = "background:#2b2b2b; padding:20px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5);";
    const rgbString = (r, g, b) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    let html = `<div style="color:#fff; font:14px sans-serif; margin-bottom:12px;">Pick color for <strong>${layerId}</strong></div>`;
    html += `<div style="display:grid; grid-template-columns:repeat(16, 24px); gap:2px; margin-bottom:12px;">`;
    for (let i = 0; i < 16; i += 1) {
      const grey = i / 15;
      const rgb = rgbString(grey, grey, grey);
      html += `<div class="color-cell" data-color="${grey},${grey},${grey}" style="width:24px; height:24px; background:${rgb}; cursor:pointer; border:1px solid #444;"></div>`;
    }
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 16; col += 1) {
        const hue = col / 16 * 360;
        const sat = 0.3 + row / 11 * 0.7;
        const light = 0.3 + col % 2 * 0.2 + row % 3 * 0.15;
        const c = (1 - Math.abs(2 * light - 1)) * sat;
        const x = c * (1 - Math.abs(hue / 60 % 2 - 1));
        const m = light - c / 2;
        let r = 0;
        let g = 0;
        let b = 0;
        if (hue < 60) {
          r = c;
          g = x;
          b = 0;
        } else if (hue < 120) {
          r = x;
          g = c;
          b = 0;
        } else if (hue < 180) {
          r = 0;
          g = c;
          b = x;
        } else if (hue < 240) {
          r = 0;
          g = x;
          b = c;
        } else if (hue < 300) {
          r = x;
          g = 0;
          b = c;
        } else {
          r = c;
          g = 0;
          b = x;
        }
        r += m;
        g += m;
        b += m;
        const rgb = rgbString(r, g, b);
        html += `<div class="color-cell" data-color="${r},${g},${b}" style="width:24px; height:24px; background:${rgb}; cursor:pointer; border:1px solid #444;"></div>`;
      }
    }
    html += `</div>`;
    const hexValue = [0, 1, 2].map((idx) => Math.round(currentColor[idx] * 255).toString(16).padStart(2, "0")).join("");
    html += `<div style="display:flex; gap:10px; align-items:center; margin-bottom:12px;">`;
    html += `<div style="color:#aaa; font:12px sans-serif;">Current:</div>`;
    html += `<div style="width:40px; height:24px; background:${rgbString(currentColor[0], currentColor[1], currentColor[2])}; border:1px solid #444;"></div>`;
    html += `<button id="resetColorBtn" style="padding:4px 10px; background:#555; color:#fff; border:none; border-radius:3px; cursor:pointer; font:11px sans-serif;">Reset to Default</button>`;
    html += `</div>`;
    html += `<div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">`;
    html += `<div style="display:flex; gap:6px; align-items:center;">`;
    html += `<label style="color:#aaa; font:11px sans-serif;">#</label>`;
    html += `<input type="text" id="hexColorInput" value="${hexValue}" maxlength="6" style="width:80px; padding:6px 8px; background:#1a1a1a; color:#fff; border:1px solid #555; border-radius:3px; font:12px monospace; text-transform:uppercase;" />`;
    html += `<button id="applyCustomBtn" style="padding:6px 12px; background:#4a9eff; color:#fff; border:none; border-radius:3px; cursor:pointer; font:11px sans-serif;">Apply</button>`;
    html += `</div>`;
    html += `<button id="cancelColorBtn" style="padding:6px 14px; background:#555; color:#fff; border:none; border-radius:4px; cursor:pointer; font:12px sans-serif;">Cancel</button>`;
    html += `</div>`;
    picker.innerHTML = html;
    modal.appendChild(picker);
    document.body.appendChild(modal);
    picker.querySelectorAll(".color-cell").forEach((cell) => {
      cell.addEventListener("click", (event) => {
        const colorStr = event.currentTarget.dataset.color;
        if (!colorStr)
          return;
        const [r, g, b] = colorStr.split(",").map(parseFloat);
        const color = [r, g, b, 1];
        this.scene.setLayerColor(layerId, color);
        this.notifyColorChange(layerId, color);
        this.refreshLayerLegend();
        modal.remove();
      });
    });
    const applyButton = document.getElementById("applyCustomBtn");
    const hexInput = document.getElementById("hexColorInput");
    applyButton?.addEventListener("click", () => {
      if (!hexInput)
        return;
      const cleaned = hexInput.value.replace(/[^0-9a-fA-F]/g, "");
      if (cleaned.length === 6) {
        const r = parseInt(cleaned.slice(0, 2), 16) / 255;
        const g = parseInt(cleaned.slice(2, 4), 16) / 255;
        const b = parseInt(cleaned.slice(4, 6), 16) / 255;
        const color = [r, g, b, 1];
        this.scene.setLayerColor(layerId, color);
        this.notifyColorChange(layerId, color);
        this.refreshLayerLegend();
        modal.remove();
      }
    });
    const resetButton = document.getElementById("resetColorBtn");
    resetButton?.addEventListener("click", () => {
      this.scene.resetLayerColor(layerId);
      this.refreshLayerLegend();
      modal.remove();
    });
    const cancelButton = document.getElementById("cancelColorBtn");
    cancelButton?.addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        modal.remove();
      }
    });
  }
  updateCoordOverlay(mouseX, mouseY, haveMouse) {
    if (!this.coordOverlayEl)
      return;
    const verts = this.renderer.lastVertexCount > 0 ? `${(this.renderer.lastVertexCount / 1e3).toFixed(1)}K` : "-";
    const tris = this.renderer.lastIndexCount > 0 ? `${(this.renderer.lastIndexCount / 3e3).toFixed(1)}K` : "-";
    if (!haveMouse) {
      this.coordOverlayEl.textContent = `x: -, y: -, zoom: ${this.scene.state.zoom.toFixed(2)}, verts: ${verts}, tris: ${tris}`;
      return;
    }
    const rect = this.renderer.canvas.getBoundingClientRect();
    const world = this.renderer.screenToWorld(mouseX - rect.left, mouseY - rect.top);
    this.coordOverlayEl.textContent = `x: ${world.x.toFixed(2)}, y: ${world.y.toFixed(2)}, zoom: ${this.scene.state.zoom.toFixed(2)}, verts: ${verts}, tris: ${tris}`;
  }
  updateStats(force = false) {
    if (!this.fpsEl)
      return;
    const now = performance.now();
    if (!force && now - this.lastStatsUpdate < 250) {
      return;
    }
    this.lastStatsUpdate = now;
    const lines = [
      `FPS: ${this.renderer.lastFps.toFixed(1)}`,
      `GPU Buffers: ${this.renderer.gpuBuffers.length} (${(this.renderer.gpuMemoryBytes / 1048576).toFixed(2)} MB)`
    ];
    const perf = performance;
    if (perf.memory) {
      const usedMB = (perf.memory.usedJSHeapSize / 1048576).toFixed(2);
      const totalMB = (perf.memory.totalJSHeapSize / 1048576).toFixed(2);
      lines.push(`JS Heap: ${usedMB} / ${totalMB} MB`);
    }
    if (this.rustMemoryBytes !== null) {
      const rustMB = (this.rustMemoryBytes / 1048576).toFixed(2);
      lines.push(`Rust Heap: ${rustMB} MB`);
    }
    this.fpsEl.innerHTML = lines.join("<br/>");
  }
  setRustMemory(bytes) {
    this.rustMemoryBytes = bytes;
  }
  notifyColorChange(layerId, color) {
    const vscode3 = window.vscode;
    if (!vscode3) {
      return;
    }
    console.log(`[COLOR] Notifying extension of color change for ${layerId}:`, color);
    vscode3.postMessage({
      command: "UpdateLayerColor",
      layerId,
      color
    });
  }
  setDebugOverlay(overlay) {
    this.debugOverlay = overlay;
    if (overlay && this.debugCoordsCheckbox) {
      this.debugCoordsCheckbox.checked = overlay.isEnabled();
    }
  }
  debugCoordsCheckbox = null;
  addDebugCoordsCheckbox() {
    const fpsEl = document.getElementById("fps");
    if (!fpsEl)
      return;
    const container = document.createElement("div");
    container.style.marginTop = "8px";
    container.style.borderTop = "1px solid #444";
    container.style.paddingTop = "8px";
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "6px";
    label.style.cursor = "pointer";
    label.style.fontSize = "11px";
    label.style.color = "#aaa";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    checkbox.style.margin = "0";
    checkbox.style.cursor = "pointer";
    this.debugCoordsCheckbox = checkbox;
    checkbox.addEventListener("change", () => {
      if (this.debugOverlay) {
        this.debugOverlay.setVisible(checkbox.checked);
        this.scene.state.needsDraw = true;
      }
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode("Show Pad Coordinates"));
    container.appendChild(label);
    fpsEl.parentElement?.insertBefore(container, fpsEl.nextSibling);
  }
  /**
   * Update layer visibility checkboxes to match a set of visible layers.
   * Used by "Show only Selected Net Layers" feature.
   */
  updateLayerVisibility(visibleLayerIds) {
    this.layersEl.querySelectorAll("input[data-layer-toggle]").forEach((checkbox) => {
      const layerId = checkbox.dataset.layerToggle;
      if (layerId) {
        checkbox.checked = visibleLayerIds.has(layerId);
      }
    });
  }
};

// webview/src/ContextMenu.ts
var ContextMenu = class {
  container;
  onHighlightNets = null;
  onHighlightComponents = null;
  onShowOnlySelectedNetLayers = null;
  hasSelection = false;
  hasComponentSelection = false;
  hasNetSelection = false;
  constructor() {
    this.container = document.createElement("div");
    this.container.className = "context-menu";
    this.container.style.cssText = `
      position: fixed;
      display: none;
      background: #252526;
      border: 1px solid #454545;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 10001;
      min-width: 180px;
      padding: 4px 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
    `;
    document.body.appendChild(this.container);
    document.addEventListener("click", (e) => {
      if (!this.container.contains(e.target)) {
        this.hide();
      }
    });
    document.addEventListener("scroll", () => this.hide(), true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.hide();
      }
    });
  }
  setOnHighlightNets(callback) {
    this.onHighlightNets = callback;
  }
  setOnHighlightComponents(callback) {
    this.onHighlightComponents = callback;
  }
  setOnShowOnlySelectedNetLayers(callback) {
    this.onShowOnlySelectedNetLayers = callback;
  }
  setHasSelection(hasSelection) {
    this.hasSelection = hasSelection;
  }
  setHasComponentSelection(hasComponentSelection) {
    this.hasComponentSelection = hasComponentSelection;
  }
  setHasNetSelection(hasNetSelection) {
    this.hasNetSelection = hasNetSelection;
  }
  createMenuItem(label, enabled, onClick) {
    const item = document.createElement("div");
    item.className = "context-menu-item";
    item.textContent = label;
    item.style.cssText = `
      padding: 6px 20px;
      cursor: ${enabled ? "pointer" : "default"};
      color: ${enabled ? "#cccccc" : "#666666"};
      white-space: nowrap;
    `;
    if (enabled) {
      item.addEventListener("mouseenter", () => {
        item.style.background = "#094771";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
      });
      item.addEventListener("click", () => {
        this.hide();
        onClick();
      });
    }
    return item;
  }
  createSeparator() {
    const sep = document.createElement("div");
    sep.style.cssText = `
      height: 1px;
      background: #454545;
      margin: 4px 0;
    `;
    return sep;
  }
  show(x, y) {
    this.container.innerHTML = "";
    const highlightNetsItem = this.createMenuItem(
      "Highlight Selected Net(s)",
      this.hasSelection && this.onHighlightNets !== null,
      () => {
        if (this.onHighlightNets) {
          this.onHighlightNets();
        }
      }
    );
    this.container.appendChild(highlightNetsItem);
    const highlightComponentsItem = this.createMenuItem(
      "Highlight Selected Component(s)",
      this.hasComponentSelection && this.onHighlightComponents !== null,
      () => {
        if (this.onHighlightComponents) {
          this.onHighlightComponents();
        }
      }
    );
    this.container.appendChild(highlightComponentsItem);
    this.container.appendChild(this.createSeparator());
    const showOnlyNetLayersItem = this.createMenuItem(
      "Show only Selected Net Layers",
      this.hasNetSelection && this.onShowOnlySelectedNetLayers !== null,
      () => {
        if (this.onShowOnlySelectedNetLayers) {
          this.onShowOnlySelectedNetLayers();
        }
      }
    );
    this.container.appendChild(showOnlyNetLayersItem);
    this.container.style.display = "block";
    const rect = this.container.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let posX = x;
    let posY = y;
    if (x + rect.width > viewportWidth) {
      posX = viewportWidth - rect.width - 10;
    }
    if (y + rect.height > viewportHeight) {
      posY = viewportHeight - rect.height - 10;
    }
    this.container.style.left = `${posX}px`;
    this.container.style.top = `${posY}px`;
  }
  hide() {
    this.container.style.display = "none";
  }
};

// webview/src/Tooltip.ts
var Tooltip = class {
  element;
  visible = false;
  constructor() {
    this.element = document.createElement("div");
    this.element.style.position = "fixed";
    this.element.style.padding = "4px 8px";
    this.element.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
    this.element.style.color = "#ffffff";
    this.element.style.fontSize = "12px";
    this.element.style.fontFamily = "monospace";
    this.element.style.borderRadius = "4px";
    this.element.style.border = "1px solid #555";
    this.element.style.pointerEvents = "none";
    this.element.style.zIndex = "2000";
    this.element.style.display = "none";
    this.element.style.whiteSpace = "pre-line";
    this.element.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.3)";
    document.body.appendChild(this.element);
  }
  show(x, y, text) {
    this.element.textContent = text;
    this.positionAndShow(x, y);
  }
  showHtml(x, y, html) {
    this.element.innerHTML = html;
    this.positionAndShow(x, y);
  }
  positionAndShow(x, y) {
    this.element.style.display = "block";
    const offsetX = 15;
    const offsetY = 15;
    const rect = this.element.getBoundingClientRect();
    let posX = x + offsetX;
    let posY = y + offsetY;
    if (posX + rect.width > window.innerWidth) {
      posX = x - rect.width - offsetX;
    }
    if (posY + rect.height > window.innerHeight) {
      posY = y - rect.height - offsetY;
    }
    this.element.style.left = `${posX}px`;
    this.element.style.top = `${posY}px`;
    this.visible = true;
  }
  hide() {
    this.element.style.display = "none";
    this.visible = false;
  }
  isVisible() {
    return this.visible;
  }
  updatePosition(x, y) {
    if (!this.visible)
      return;
    const offsetX = 15;
    const offsetY = 15;
    const rect = this.element.getBoundingClientRect();
    let posX = x + offsetX;
    let posY = y + offsetY;
    if (posX + rect.width > window.innerWidth) {
      posX = x - rect.width - offsetX;
    }
    if (posY + rect.height > window.innerHeight) {
      posY = y - rect.height - offsetY;
    }
    this.element.style.left = `${posX}px`;
    this.element.style.top = `${posY}px`;
  }
};

// webview/src/Input.ts
var Input = class {
  scene;
  renderer;
  ui;
  canvas;
  onSelect;
  contextMenu;
  tooltip;
  haveMouse = false;
  lastMouseX = 0;
  lastMouseY = 0;
  dragStartX = 0;
  dragStartY = 0;
  ZOOM_SPEED = 5e-3;
  MIN_ZOOM = 0.1;
  MAX_ZOOM = 500;
  selectionBox;
  onDelete = null;
  onUndo = null;
  onRedo = null;
  onBoxSelect = null;
  onHighlightNets = null;
  onClearSelection = null;
  // Hover tooltip tracking
  hoverTimer = null;
  hoverDelayMs = 500;
  // 0.5 second delay
  onQueryNetAtPoint = null;
  lastClickCtrlKey = false;
  // Track if Ctrl was held during click
  lastClickX = 0;
  // Track click position for selection tooltip
  lastClickY = 0;
  constructor(scene, renderer, ui, onSelect) {
    this.scene = scene;
    this.renderer = renderer;
    this.ui = ui;
    this.canvas = renderer.canvas;
    this.onSelect = onSelect;
    this.contextMenu = new ContextMenu();
    this.tooltip = new Tooltip();
    this.selectionBox = document.createElement("div");
    this.selectionBox.style.position = "fixed";
    this.selectionBox.style.border = "1px solid #007acc";
    this.selectionBox.style.backgroundColor = "rgba(0, 122, 204, 0.1)";
    this.selectionBox.style.pointerEvents = "none";
    this.selectionBox.style.display = "none";
    this.selectionBox.style.zIndex = "1000";
    document.body.appendChild(this.selectionBox);
    this.setupListeners();
  }
  setOnDelete(callback) {
    this.onDelete = callback;
  }
  setOnUndo(callback) {
    this.onUndo = callback;
  }
  setOnRedo(callback) {
    this.onRedo = callback;
  }
  setOnBoxSelect(callback) {
    this.onBoxSelect = callback;
  }
  setOnClearSelection(callback) {
    this.onClearSelection = callback;
  }
  setOnHighlightNets(callback) {
    this.onHighlightNets = callback;
    this.contextMenu.setOnHighlightNets(callback);
  }
  setOnHighlightComponents(callback) {
    this.contextMenu.setOnHighlightComponents(callback);
  }
  setOnShowOnlySelectedNetLayers(callback) {
    this.contextMenu.setOnShowOnlySelectedNetLayers(callback);
  }
  setHasSelection(hasSelection) {
    this.contextMenu.setHasSelection(hasSelection);
  }
  setHasComponentSelection(hasComponentSelection) {
    this.contextMenu.setHasComponentSelection(hasComponentSelection);
  }
  setHasNetSelection(hasNetSelection) {
    this.contextMenu.setHasNetSelection(hasNetSelection);
  }
  setOnQueryNetAtPoint(callback) {
    this.onQueryNetAtPoint = callback;
  }
  showNetTooltip(netName, clientX, clientY) {
    if (netName) {
      this.tooltip.show(clientX, clientY, `Net: ${netName}`);
    }
  }
  showSelectionTooltip(info, clientX, clientY) {
    const lines = [];
    if (info.net) {
      lines.push(`<span style="color: #4fc3f7;">Net:</span> ${this.escapeHtml(info.net)}`);
    }
    if (info.component) {
      lines.push(`<span style="color: #81c784;">Component:</span> ${this.escapeHtml(info.component)}`);
    }
    if (info.pin) {
      lines.push(`<span style="color: #fff176;">Pin:</span> ${this.escapeHtml(info.pin)}`);
    }
    if (lines.length > 0) {
      this.tooltip.showHtml(clientX, clientY, lines.join("<br>"));
    }
  }
  escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  hideTooltip() {
    this.tooltip.hide();
  }
  getLastClickPosition() {
    return { x: this.lastClickX, y: this.lastClickY };
  }
  startHoverTimer(clientX, clientY) {
    this.cancelHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.checkHoverObject(clientX, clientY);
    }, this.hoverDelayMs);
  }
  cancelHoverTimer() {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.tooltip.hide();
  }
  checkHoverObject(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const world = this.renderer.screenToWorld(cssX, cssY);
    if (this.onQueryNetAtPoint) {
      this.onQueryNetAtPoint(world.x, world.y, clientX, clientY);
    }
  }
  setupListeners() {
    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.contextMenu.show(event.clientX, event.clientY);
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.onClearSelection) {
          this.onClearSelection();
        }
      } else if (event.key === "Delete" || event.ctrlKey && (event.key === "d" || event.key === "D")) {
        event.preventDefault();
        console.log("[Input] Delete key pressed");
        if (this.onDelete) {
          this.onDelete();
        }
      } else if (event.ctrlKey && (event.key === "z" || event.key === "Z") && !event.shiftKey) {
        event.preventDefault();
        console.log("[Input] Undo (Ctrl+Z) pressed");
        if (this.onUndo) {
          this.onUndo();
        }
      } else if (event.ctrlKey && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        console.log("[Input] Redo (Ctrl+Y) pressed");
        if (this.onRedo) {
          this.onRedo();
        }
      }
    });
    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1)
        return;
      this.scene.state.dragging = true;
      this.scene.state.dragButton = event.button;
      this.scene.state.lastX = event.clientX;
      this.scene.state.lastY = event.clientY;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.lastClickCtrlKey = event.ctrlKey;
      this.canvas.setPointerCapture(event.pointerId);
      if (event.button === 1) {
        this.canvas.style.cursor = "grabbing";
      } else if (event.button === 0) {
        this.canvas.style.cursor = "crosshair";
        this.selectionBox.style.display = "block";
        this.selectionBox.style.left = `${event.clientX}px`;
        this.selectionBox.style.top = `${event.clientY}px`;
        this.selectionBox.style.width = "0px";
        this.selectionBox.style.height = "0px";
      }
    });
    this.canvas.addEventListener("pointermove", (event) => {
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
      this.haveMouse = true;
      if (!this.scene.state.dragging) {
        this.startHoverTimer(event.clientX, event.clientY);
      } else {
        this.cancelHoverTimer();
      }
      if (this.scene.state.dragging) {
        const dx = event.clientX - this.scene.state.lastX;
        const dy = event.clientY - this.scene.state.lastY;
        this.scene.state.lastX = event.clientX;
        this.scene.state.lastY = event.clientY;
        if (this.scene.state.dragButton === 1) {
          const dpr = window.devicePixelRatio || 1;
          this.scene.state.panX += dx * dpr / this.scene.state.zoom;
          this.scene.state.panY -= dy * dpr / this.scene.state.zoom;
          this.scene.state.needsDraw = true;
        } else if (this.scene.state.dragButton === 0) {
          const x = Math.min(event.clientX, this.dragStartX);
          const y = Math.min(event.clientY, this.dragStartY);
          const w = Math.abs(event.clientX - this.dragStartX);
          const h = Math.abs(event.clientY - this.dragStartY);
          this.selectionBox.style.left = `${x}px`;
          this.selectionBox.style.top = `${y}px`;
          this.selectionBox.style.width = `${w}px`;
          this.selectionBox.style.height = `${h}px`;
        }
      }
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    });
    const endDrag = (event) => {
      if (!this.scene.state.dragging)
        return;
      const dist = Math.hypot(event.clientX - this.dragStartX, event.clientY - this.dragStartY);
      if (dist < 5 && this.scene.state.dragButton === 0) {
        this.handleClick(event.clientX, event.clientY);
      } else if (dist >= 5 && this.scene.state.dragButton === 0) {
        this.handleBoxSelect(this.dragStartX, this.dragStartY, event.clientX, event.clientY);
      }
      if (this.scene.state.dragButton === 0) {
        this.selectionBox.style.display = "none";
      }
      this.scene.state.dragging = false;
      this.scene.state.dragButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.canvas.style.cursor = "grab";
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
    this.canvas.addEventListener("mouseleave", () => {
      this.haveMouse = false;
      this.cancelHoverTimer();
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const pivotWorld = this.renderer.screenToWorld(cssX, cssY);
      const factor = Math.exp(-event.deltaY * this.ZOOM_SPEED);
      this.scene.state.zoom = this.clamp(this.scene.state.zoom * factor, this.MIN_ZOOM, this.MAX_ZOOM);
      const width = Math.max(1, this.canvas.width);
      const height = Math.max(1, this.canvas.height);
      const fx = this.scene.state.flipX ? -1 : 1;
      const fy = this.scene.state.flipY ? -1 : 1;
      const scaleX = 2 * this.scene.state.zoom / width;
      const scaleY = 2 * this.scene.state.zoom / height;
      const xNdc = 2 * cssX / Math.max(1, this.canvas.clientWidth) - 1;
      const yNdc = 1 - 2 * cssY / Math.max(1, this.canvas.clientHeight);
      this.scene.state.panX = (xNdc / fx + 1) / scaleX - width / 2 - pivotWorld.x;
      this.scene.state.panY = (1 - yNdc * fy) / scaleY - height / 2 - pivotWorld.y;
      this.scene.state.needsDraw = true;
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    }, { passive: false });
    this.canvas.addEventListener("mousemove", () => {
      this.scene.state.needsDraw = true;
    });
  }
  handleClick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const world = this.renderer.screenToWorld(cssX, cssY);
    this.lastClickX = clientX;
    this.lastClickY = clientY;
    this.onSelect(world.x, world.y, this.lastClickCtrlKey);
  }
  handleBoxSelect(startX, startY, endX, endY) {
    const rect = this.canvas.getBoundingClientRect();
    const start = this.renderer.screenToWorld(startX - rect.left, startY - rect.top);
    const end = this.renderer.screenToWorld(endX - rect.left, endY - rect.top);
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);
    console.log(`[Input] Box select: (${minX.toFixed(2)}, ${minY.toFixed(2)}) to (${maxX.toFixed(2)}, ${maxY.toFixed(2)})`);
    if (this.onBoxSelect) {
      this.onBoxSelect(minX, minY, maxX, maxY);
    }
  }
  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
};

// webview/src/BinaryParserPool.ts
var BinaryParserPool = class {
  workers = [];
  availableWorkers = [];
  pendingTasks = [];
  taskIdCounter = 0;
  taskResolvers = /* @__PURE__ */ new Map();
  constructor(numWorkers = navigator.hardwareConcurrency || 4) {
    console.log(`[BinaryParserPool] Creating ${numWorkers} workers`);
    const workerSourceScript = document.getElementById("worker-source");
    let workerUrl = "";
    if (workerSourceScript && workerSourceScript.textContent) {
      const blob = new Blob([workerSourceScript.textContent], { type: "application/javascript" });
      workerUrl = URL.createObjectURL(blob);
      console.log("[BinaryParserPool] Using embedded worker source");
    } else {
      workerUrl = "/dist/binaryParserWorker.js";
      console.log("[BinaryParserPool] Using external worker file");
    }
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(workerUrl);
      worker.onmessage = (event) => this.handleWorkerMessage(event, worker);
      worker.onerror = (error) => {
        console.error(`[BinaryParserPool] Worker ${i} error:`, error);
      };
      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
  }
  /**
   * Parse binary layer data using an available worker
   * Returns a promise that resolves with the parsed LayerJSON
   */
  async parse(buffer) {
    const taskId = this.taskIdCounter++;
    return new Promise((resolve, reject) => {
      const task = { id: taskId, buffer, resolve, reject };
      const worker = this.availableWorkers.pop();
      if (worker) {
        this.startTask(worker, task);
      } else {
        this.pendingTasks.push(task);
      }
      this.taskResolvers.set(taskId, { resolve, reject });
    });
  }
  startTask(worker, task) {
    worker.postMessage(
      {
        type: "parse",
        id: task.id,
        buffer: task.buffer
      },
      [task.buffer]
      // Transfer buffer ownership to worker
    );
  }
  handleWorkerMessage(event, worker) {
    const { type, id, layer, parseTime, error } = event.data;
    const resolvers = this.taskResolvers.get(id);
    if (!resolvers) {
      console.error(`[BinaryParserPool] No resolver found for task ${id}`);
      return;
    }
    this.taskResolvers.delete(id);
    if (type === "parsed") {
      resolvers.resolve(layer);
    } else if (type === "error") {
      console.error(`[BinaryParserPool] Task ${id} failed:`, error);
      resolvers.reject(new Error(error));
    }
    const nextTask = this.pendingTasks.shift();
    if (nextTask) {
      this.startTask(worker, nextTask);
    } else {
      this.availableWorkers.push(worker);
    }
  }
  /**
   * Terminate all workers
   */
  terminate() {
    console.log("[BinaryParserPool] Terminating all workers");
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.availableWorkers = [];
    this.pendingTasks = [];
    this.taskResolvers.clear();
  }
  /**
   * Get statistics about the pool
   */
  getStats() {
    return {
      totalWorkers: this.workers.length,
      availableWorkers: this.availableWorkers.length,
      pendingTasks: this.pendingTasks.length,
      activeTasks: this.taskResolvers.size
    };
  }
};

// webview/src/DebugOverlay.ts
var DEBUG_SHOW_COORDS = false;
var DebugOverlay = class {
  canvas;
  ctx;
  scene;
  renderer;
  debugPoints = [];
  enabled = false;
  // Default to OFF
  // Limit points to avoid overwhelming the display
  maxPoints = 5e3;
  constructor(gpuCanvas, scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10;
    `;
    gpuCanvas.parentElement?.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.resize(gpuCanvas.width, gpuCanvas.height);
    const resizeObserver = new ResizeObserver(() => {
      this.resize(gpuCanvas.width, gpuCanvas.height);
    });
    resizeObserver.observe(gpuCanvas);
    console.log("[DebugOverlay] Initialized - Use checkbox to toggle coordinate labels");
  }
  resize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.clear();
    }
    console.log(`[DebugOverlay] ${this.enabled ? "Enabled" : "Disabled"}`);
  }
  setVisible(visible) {
    this.enabled = visible;
    if (!this.enabled) {
      this.clear();
    }
    console.log(`[DebugOverlay] ${this.enabled ? "Enabled" : "Disabled"}`);
  }
  isEnabled() {
    return this.enabled;
  }
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  /**
   * Extract debug points from layer geometry
   * Call this when layers are loaded
   */
  extractPointsFromLayers() {
    this.debugPoints = [];
    let pointCount = 0;
    for (const [renderKey, renderData] of this.scene.layerRenderData) {
      const layerId = renderData.layerId;
      if (!this.scene.layerVisible.get(layerId))
        continue;
      const color = this.scene.getLayerColor(layerId);
      const colorStr = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, 1)`;
      if (renderData.cpuInstanceBuffers && renderData.cpuInstanceBuffers.length > 0) {
        const totalLODs = renderData.cpuInstanceBuffers.length;
        const numShapes = Math.floor(totalLODs / 3);
        for (let shapeIdx = 0; shapeIdx < numShapes && pointCount < this.maxPoints; shapeIdx++) {
          const lodData = renderData.cpuInstanceBuffers[shapeIdx];
          if (!lodData)
            continue;
          const floatsPerInstance = 3;
          const prefix = renderData.shaderType === "instanced" ? "V:" : "";
          for (let i = 0; i < lodData.length && pointCount < this.maxPoints; i += floatsPerInstance) {
            const x = lodData[i];
            const y = lodData[i + 1];
            this.debugPoints.push({
              worldX: x,
              worldY: y,
              label: `${prefix}${x.toFixed(2)},${y.toFixed(2)}`,
              color: renderData.shaderType === "instanced" ? "#00ffff" : colorStr
            });
            pointCount++;
          }
        }
      }
    }
    console.log(`[DebugOverlay] Extracted ${this.debugPoints.length} debug points from ${this.scene.layerRenderData.size} render entries`);
  }
  /**
   * Convert world coordinates to screen coordinates
   * Use the Renderer's worldToScreen for consistency
   */
  worldToScreen(worldX, worldY) {
    const result = this.renderer.worldToScreen(worldX, worldY);
    return [result.x, result.y];
  }
  /**
   * Render debug labels
   * Call this after GPU render, passing current view bounds
   */
  render() {
    if (!this.enabled)
      return;
    this.clear();
    const { zoom } = this.scene.state;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (zoom < 5) {
      this.ctx.font = "12px monospace";
      this.ctx.fillStyle = "rgba(255, 255, 0, 0.8)";
      this.ctx.fillText("Zoom in more to see coordinate labels", 10, 20);
      return;
    }
    const fontSize = Math.max(8, Math.min(14, zoom * 0.8));
    this.ctx.font = `${fontSize}px monospace`;
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "bottom";
    let rendered = 0;
    const maxRender = 500;
    for (const pt of this.debugPoints) {
      if (rendered >= maxRender)
        break;
      const [sx, sy] = this.worldToScreen(pt.worldX, pt.worldY);
      if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50)
        continue;
      const textWidth = this.ctx.measureText(pt.label).width;
      const padding = 4;
      const boxHeight = fontSize + padding * 2;
      const boxWidth = textWidth + padding * 2;
      this.ctx.fillStyle = "rgba(30, 30, 30, 0.9)";
      this.ctx.strokeStyle = "rgba(100, 100, 100, 0.8)";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.roundRect(sx + 5, sy - boxHeight - 2, boxWidth, boxHeight, 3);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.fillStyle = "#ffffff";
      this.ctx.fillText(pt.label, sx + 5 + padding, sy - padding - 2);
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      this.ctx.fillStyle = pt.color;
      this.ctx.fill();
      this.ctx.strokeStyle = "#000";
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
      rendered++;
    }
    this.ctx.font = "12px monospace";
    this.ctx.fillStyle = "rgba(255, 255, 0, 0.8)";
    this.ctx.fillText(`Debug: ${rendered}/${this.debugPoints.length} pts | zoom=${zoom.toFixed(1)} | canvas=${w}x${h}`, 10, 20);
    if (this.debugPoints.length > 0 && rendered === 0) {
      const pt = this.debugPoints[0];
      const [sx, sy] = this.worldToScreen(pt.worldX, pt.worldY);
      console.log(`[DebugOverlay] First point: world(${pt.worldX.toFixed(2)}, ${pt.worldY.toFixed(2)}) -> screen(${sx.toFixed(0)}, ${sy.toFixed(0)}), canvas ${w}x${h}`);
    }
  }
};

// webview/src/main.ts
var isVSCodeWebview = !!window.acquireVsCodeApi;
var vscode2 = isVSCodeWebview ? window.acquireVsCodeApi() : null;
if (vscode2) {
  window.vscode = vscode2;
}
if (!isVSCodeWebview) {
  const debugConsole = document.createElement("div");
  debugConsole.id = "debug-console";
  debugConsole.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 300px;
        background: rgba(30, 30, 30, 0.95);
        color: #d4d4d4;
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 12px;
        overflow-y: auto;
        padding: 8px;
        border-top: 2px solid #007acc;
        z-index: 10000;
        display: flex;
        flex-direction: column;
    `;
  const header = document.createElement("div");
  header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 4px;
        border-bottom: 1px solid #555;
        margin-bottom: 4px;
        flex-shrink: 0;
    `;
  header.innerHTML = `
        <span style="font-weight: bold; color: #007acc;">[Dev Server Debug Console]</span>
        <button id="clear-console" style="
            background: #007acc;
            color: white;
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 11px;
            border-radius: 3px;
        ">Clear</button>
    `;
  const logContainer = document.createElement("div");
  logContainer.id = "log-container";
  logContainer.style.cssText = "flex: 1; overflow-y: auto;";
  debugConsole.appendChild(header);
  debugConsole.appendChild(logContainer);
  document.body.appendChild(debugConsole);
  const clearButton = document.getElementById("clear-console");
  clearButton?.addEventListener("click", () => {
    logContainer.innerHTML = "";
  });
  const addLogEntry = (type, args) => {
    const entry = document.createElement("div");
    entry.style.cssText = "padding: 2px 0; border-bottom: 1px solid #333;";
    const typeColors = {
      log: "#d4d4d4",
      error: "#f48771",
      warn: "#dcdcaa",
      info: "#4fc1ff"
    };
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().substring(11, 23);
    const color = typeColors[type] || "#d4d4d4";
    const formattedArgs = args.map((arg) => {
      if (typeof arg === "object") {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    }).join(" ");
    entry.innerHTML = `<span style="color: #858585;">[${timestamp}]</span> <span style="color: ${color};">${formattedArgs}</span>`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  };
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.log = (...args) => {
    addLogEntry("log", args);
    originalLog.apply(console, args);
  };
  console.error = (...args) => {
    addLogEntry("error", args);
    originalError.apply(console, args);
  };
  console.warn = (...args) => {
    addLogEntry("warn", args);
    originalWarn.apply(console, args);
  };
  console.info = (...args) => {
    addLogEntry("info", args);
    originalInfo.apply(console, args);
  };
}
if (isVSCodeWebview && vscode2) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const serializeArgs = (args) => args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}
${arg.stack || ""}`;
    }
    return arg;
  });
  console.log = (...args) => {
    vscode2.postMessage({ command: "console.log", args: serializeArgs(args) });
    originalLog.apply(console, args);
  };
  console.error = (...args) => {
    vscode2.postMessage({ command: "console.error", args: serializeArgs(args) });
    originalError.apply(console, args);
  };
  console.warn = (...args) => {
    vscode2.postMessage({ command: "console.warn", args: serializeArgs(args) });
    originalWarn.apply(console, args);
  };
  console.info = (...args) => {
    vscode2.postMessage({ command: "console.info", args: serializeArgs(args) });
    originalInfo.apply(console, args);
  };
}
async function init() {
  const initStart = performance.now();
  console.log("[INIT] Starting initialization...");
  console.log(`[INIT] Mode: ${isVSCodeWebview ? "VS Code Extension" : "Dev Server"}`);
  const canvasElement = document.getElementById("viewer");
  if (!(canvasElement instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element #viewer was not found");
  }
  const scene = new Scene();
  const renderer = new Renderer(canvasElement, scene);
  const ui = new UI(scene, renderer);
  console.log("[INIT] Initializing WebGPU renderer...");
  await renderer.init();
  console.log("[INIT] WebGPU renderer initialized");
  const debugOverlay = new DebugOverlay(canvasElement, scene, renderer);
  if (!DEBUG_SHOW_COORDS) {
    debugOverlay.setVisible(false);
  }
  ui.setDebugOverlay(debugOverlay);
  let selectedObjects = [];
  let deletedObjectIds = /* @__PURE__ */ new Set();
  let isBoxSelect = false;
  let isCtrlSelect = false;
  let lastNetHighlightAllObjects = [];
  const input = new Input(scene, renderer, ui, (x, y, ctrlKey) => {
    isBoxSelect = false;
    isCtrlSelect = ctrlKey;
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "Select", x, y });
    } else {
      console.log(`[Dev] Select at ${x}, ${y}${ctrlKey ? " (Ctrl+click, append mode)" : ""}`);
    }
  });
  input.setOnBoxSelect((minX, minY, maxX, maxY) => {
    isBoxSelect = true;
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "BoxSelect", minX, minY, maxX, maxY });
    } else {
      console.log(`[Dev] Box select: (${minX}, ${minY}) to (${maxX}, ${maxY})`);
    }
  });
  input.setOnHighlightNets(() => {
    if (selectedObjects.length === 0) {
      console.log("[HighlightNets] No objects selected");
      return;
    }
    const objectIds = selectedObjects.map((obj) => obj.id);
    console.log(`[HighlightNets] Requesting nets for ${objectIds.length} selected object(s)`);
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "HighlightSelectedNets", objectIds });
    } else {
      console.log(`[Dev] Highlight nets for objects: ${objectIds.join(", ")}`);
    }
  });
  input.setOnHighlightComponents(() => {
    if (selectedObjects.length === 0) {
      console.log("[HighlightComponents] No objects selected");
      return;
    }
    const objectIds = selectedObjects.map((obj) => obj.id);
    console.log(`[HighlightComponents] Requesting components for ${objectIds.length} selected object(s)`);
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "HighlightSelectedComponents", objectIds });
    } else {
      console.log(`[Dev] Highlight components for objects: ${objectIds.join(", ")}`);
    }
  });
  input.setOnQueryNetAtPoint((worldX, worldY, clientX, clientY) => {
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "QueryNetAtPoint", x: worldX, y: worldY, clientX, clientY });
    } else {
      console.log(`[Dev] Query net at point: (${worldX}, ${worldY})`);
    }
  });
  input.setOnShowOnlySelectedNetLayers(() => {
    const objectsToUse = lastNetHighlightAllObjects.length > 0 ? lastNetHighlightAllObjects : selectedObjects;
    if (objectsToUse.length === 0) {
      console.log("[ShowOnlyNetLayers] No objects selected");
      return;
    }
    const selectedLayerIds = /* @__PURE__ */ new Set();
    for (const obj of objectsToUse) {
      if (obj.obj_type === 2)
        continue;
      if (obj.layer_id.includes("PTH") || obj.layer_id.includes("Drill"))
        continue;
      selectedLayerIds.add(obj.layer_id);
    }
    console.log(`[ShowOnlyNetLayers] Showing only layers: ${Array.from(selectedLayerIds).join(", ")}`);
    if (selectedLayerIds.size === 0) {
      console.log("[ShowOnlyNetLayers] All selected objects are vias/PTH, not changing layer visibility");
      return;
    }
    for (const [layerId, _visible] of scene.layerVisible) {
      const shouldBeVisible = selectedLayerIds.has(layerId);
      scene.toggleLayerVisibility(layerId, shouldBeVisible);
    }
    ui.updateLayerVisibility(selectedLayerIds);
    const visibleObjects = objectsToUse.filter((obj) => selectedLayerIds.has(obj.layer_id));
    if (visibleObjects.length > 0) {
      selectedObjects = visibleObjects;
      scene.highlightMultipleObjects(visibleObjects);
      console.log(`[ShowOnlyNetLayers] Updated selection to ${visibleObjects.length} objects on visible layers`);
    }
  });
  const MAX_UNDO_HISTORY = 100;
  const undoStack = [];
  const redoStack = [];
  function performDelete(objects, source) {
    if (objects.length === 0)
      return;
    console.log(`[Delete] Deleting ${objects.length} object(s) (${source})`);
    scene.clearHighlightObject();
    for (const obj of objects) {
      scene.hideObject(obj);
      deletedObjectIds.add(obj.id);
      if (isVSCodeWebview && vscode2) {
        vscode2.postMessage({ command: "Delete", object: obj });
      }
    }
    undoStack.push([...objects]);
    if (undoStack.length > MAX_UNDO_HISTORY) {
      undoStack.shift();
    }
    redoStack.length = 0;
    selectedObjects = [];
    console.log(`[Delete] Deleted ${objects.length} object(s)`);
  }
  function performUndo() {
    if (undoStack.length === 0) {
      console.log("[Undo] Nothing to undo");
      return;
    }
    const batch = undoStack.pop();
    console.log(`[Undo] Restoring ${batch.length} object(s)`);
    for (const obj of batch) {
      scene.showObject(obj);
      deletedObjectIds.delete(obj.id);
      if (isVSCodeWebview && vscode2) {
        vscode2.postMessage({ command: "Undo", object: obj });
      }
    }
    redoStack.push(batch);
    if (redoStack.length > MAX_UNDO_HISTORY) {
      redoStack.shift();
    }
  }
  function performRedo() {
    if (redoStack.length === 0) {
      console.log("[Redo] Nothing to redo");
      return;
    }
    const batch = redoStack.pop();
    console.log(`[Redo] Re-deleting ${batch.length} object(s)`);
    for (const obj of batch) {
      scene.hideObject(obj);
      deletedObjectIds.add(obj.id);
      if (isVSCodeWebview && vscode2) {
        vscode2.postMessage({ command: "Redo", object: obj });
      }
    }
    undoStack.push(batch);
    if (undoStack.length > MAX_UNDO_HISTORY) {
      undoStack.shift();
    }
  }
  ui.setOnDelete(() => {
    if (selectedObjects.length > 0) {
      performDelete(selectedObjects, "context menu");
    }
  });
  input.setOnDelete(() => {
    if (selectedObjects.length > 0) {
      performDelete(selectedObjects, "keyboard");
    }
  });
  input.setOnUndo(() => {
    performUndo();
  });
  input.setOnRedo(() => {
    performRedo();
  });
  input.setOnClearSelection(() => {
    if (selectedObjects.length > 0) {
      console.log("[Input] Escape pressed - clearing selection");
      selectedObjects = [];
      scene.clearHighlightObject();
      ui.clearHighlight();
      input.setHasSelection(false);
      input.setHasComponentSelection(false);
    }
  });
  ui.refreshLayerLegend();
  ui.updateStats(true);
  scene.state.needsDraw = true;
  if (isVSCodeWebview && vscode2) {
    console.log("[INIT] Notifying extension that webview is ready");
    vscode2.postMessage({ command: "ready" });
  }
  const workerPool = new BinaryParserPool();
  console.log(`[INIT] Worker pool created with ${workerPool.getStats().totalWorkers} workers`);
  let pendingLayers = [];
  let batchTimeout = null;
  const BATCH_DELAY_MS = 0;
  function processPendingLayers() {
    if (pendingLayers.length === 0)
      return;
    const batchStart = performance.now();
    console.log(`[BATCH] Processing ${pendingLayers.length} layers at once...`);
    for (const layerJson of pendingLayers) {
      scene.loadLayerData(layerJson);
    }
    ui.refreshLayerLegend();
    renderer.finishLoading();
    if (debugOverlay) {
      debugOverlay.extractPointsFromLayers();
    }
    const batchEnd = performance.now();
    console.log(`[BATCH] Loaded ${pendingLayers.length} layers in ${(batchEnd - batchStart).toFixed(1)}ms`);
    pendingLayers = [];
    batchTimeout = null;
  }
  window.addEventListener("message", async (event) => {
    const msgStart = performance.now();
    const data = event.data;
    if (data.command === "saveComplete") {
      const filePath = data.filePath;
      console.log(`[SAVE] Save completed: ${filePath || "unknown path"}`);
      const saveBtn = document.getElementById("savePcbBtn");
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "\u{1F4BE} Save";
      }
      return;
    }
    if (data.command === "saveError") {
      const error = data.error;
      console.error(`[SAVE] Save failed: ${error || "unknown error"}`);
      const saveBtn = document.getElementById("savePcbBtn");
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "\u{1F4BE} Save";
      }
      return;
    }
    if (data.command === "binaryTessellationData" && data.binaryPayload) {
      const payload = data.binaryPayload;
      let arrayBuffer;
      if (payload instanceof ArrayBuffer) {
        arrayBuffer = payload;
      } else if (payload instanceof Uint8Array) {
        if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
          arrayBuffer = payload.buffer;
        } else {
          arrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        }
      } else if (typeof payload === "string") {
        const binaryString = atob(payload);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        arrayBuffer = bytes.buffer;
      } else if (typeof payload === "object" && payload !== null) {
        const obj = payload;
        const keys = Object.keys(obj);
        const bytes = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          bytes[i] = obj[i];
        }
        arrayBuffer = bytes.buffer;
      } else {
        console.error(`[MSG] Unexpected binaryPayload type: ${typeof payload}`);
        return;
      }
      try {
        const layerJson = await workerPool.parse(arrayBuffer);
        pendingLayers.push(layerJson);
        if (batchTimeout !== null) {
          clearTimeout(batchTimeout);
        }
        batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      } catch (error) {
        console.error(`[MSG] Binary parsing failed:`, error);
      }
    } else if (data.command === "tessellationData" && data.payload) {
      const layerJson = data.payload;
      const msgEnd = performance.now();
      console.log(`[MSG] Received JSON ${layerJson.layerId} (parsed in ${(msgEnd - msgStart).toFixed(1)}ms)`);
      pendingLayers.push(layerJson);
      if (batchTimeout !== null) {
        clearTimeout(batchTimeout);
      }
      batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
    } else if (data.command === "error") {
      console.error(`Extension error: ${data.message}`);
    } else if (data.command === "selectionResult" && data.ranges) {
      const ranges = data.ranges;
      const visibleRanges = ranges.filter((range) => {
        const isDeleted = deletedObjectIds.has(range.id);
        const isLayerVisible = scene.layerVisible.get(range.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      if (visibleRanges.length > 0) {
        visibleRanges.sort((a, b) => {
          const aIndex = scene.layerOrder.indexOf(a.layer_id);
          const bIndex = scene.layerOrder.indexOf(b.layer_id);
          return bIndex - aIndex;
        });
        if (isBoxSelect) {
          selectedObjects = visibleRanges;
          scene.highlightMultipleObjects(visibleRanges);
          input.hideTooltip();
        } else if (isCtrlSelect) {
          const newObj = visibleRanges[0];
          const existingIndex = selectedObjects.findIndex((obj) => obj.id === newObj.id);
          if (existingIndex >= 0) {
            selectedObjects.splice(existingIndex, 1);
            console.log(`[Select] Ctrl+click: removed object ${newObj.id} from selection (${selectedObjects.length} remaining)`);
          } else {
            selectedObjects.push(newObj);
            console.log(`[Select] Ctrl+click: added object ${newObj.id} to selection (${selectedObjects.length} total)`);
          }
          if (selectedObjects.length > 0) {
            scene.highlightMultipleObjects(selectedObjects);
          } else {
            scene.clearHighlightObject();
          }
          input.hideTooltip();
        } else {
          const selected = visibleRanges[0];
          selectedObjects = [selected];
          scene.highlightObject(selected);
        }
        lastNetHighlightAllObjects = [];
        input.setHasSelection(selectedObjects.length > 0);
        const hasComponentRef = selectedObjects.some((obj) => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        const hasNetName = selectedObjects.some((obj) => obj.net_name && obj.net_name !== "No Net");
        input.setHasNetSelection(hasNetName);
      } else if (!isCtrlSelect) {
        selectedObjects = [];
        lastNetHighlightAllObjects = [];
        scene.clearHighlightObject();
        input.setHasSelection(false);
        input.setHasComponentSelection(false);
        input.setHasNetSelection(false);
        input.hideTooltip();
      }
    } else if (data.command === "highlightNetsResult" && data.objects) {
      const objects = data.objects;
      const netNames = data.netNames;
      console.log(`[HighlightNets] Received ${objects.length} objects with nets: ${netNames.join(", ")}`);
      lastNetHighlightAllObjects = objects.filter((obj) => !deletedObjectIds.has(obj.id));
      const visibleObjects = objects.filter((obj) => {
        const isDeleted = deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      if (visibleObjects.length > 0) {
        selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightNets] Highlighted ${visibleObjects.length} objects for nets: ${netNames.join(", ")}`);
        input.setHasSelection(true);
        const hasComponentRef = visibleObjects.some((obj) => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        input.setHasNetSelection(true);
      }
    } else if (data.command === "highlightComponentsResult" && data.objects) {
      const objects = data.objects;
      const componentRefs = data.componentRefs;
      console.log(`[HighlightComponents] Received ${objects.length} objects with components: ${componentRefs.join(", ")}`);
      const visibleObjects = objects.filter((obj) => {
        const isDeleted = deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      if (visibleObjects.length > 0) {
        selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightComponents] Highlighted ${visibleObjects.length} objects for components: ${componentRefs.join(", ")}`);
        input.setHasSelection(true);
        const hasComponentRef = visibleObjects.some((obj) => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        const hasNetName = visibleObjects.some((obj) => obj.net_name && obj.net_name !== "No Net");
        input.setHasNetSelection(hasNetName);
      }
    } else if (data.command === "netAtPointResult") {
      const netName = data.netName;
      const componentRef = data.componentRef;
      const pinRef = data.pinRef;
      const clientX = data.x;
      const clientY = data.y;
      if (netName && netName.trim() !== "") {
        const tooltipInfo = {
          net: netName
        };
        if (componentRef) {
          tooltipInfo.component = componentRef.replace(/^CMP:/, "");
        }
        if (pinRef) {
          tooltipInfo.pin = pinRef.replace(/^PIN:/, "");
        }
        input.showSelectionTooltip(tooltipInfo, clientX, clientY);
      }
    } else if (data.command === "deleteRelatedObjects" && data.objects) {
      const relatedObjects = data.objects;
      console.log(`[Delete] Hiding ${relatedObjects.length} related objects (vias across layers)`);
      for (const obj of relatedObjects) {
        scene.hideObject(obj);
        deletedObjectIds.add(obj.id);
      }
      scene.state.needsDraw = true;
    } else if (data.command === "memoryResult") {
      const memoryBytes = data.memoryBytes;
      ui.setRustMemory(memoryBytes);
    } else if (data.command === "drcRegionsResult") {
      const regions = data.regions;
      const elapsedMs = data.elapsedMs;
      console.log(`[DRC] Received ${regions.length} DRC regions in ${elapsedMs.toFixed(2)}ms`);
      scene.loadDrcRegions(regions);
      if (regions.length > 0) {
        const firstRegion = scene.navigateToDrcRegion(0);
        if (firstRegion) {
          renderer.fitToBounds(firstRegion.bounds, 0.3);
          for (const [layerId, _visible] of scene.layerVisible) {
            scene.toggleLayerVisibility(layerId, layerId === firstRegion.layer_id);
          }
          ui.updateLayerVisibility(/* @__PURE__ */ new Set([firstRegion.layer_id]));
        }
        ui.updateDrcPanel(regions.length, 0, firstRegion);
      } else {
        ui.updateDrcPanel(0, 0, null);
      }
    }
  });
  ui.setOnRunDrc(() => {
    console.log("[DRC] Running DRC...");
    if (isVSCodeWebview && vscode2) {
      vscode2.postMessage({ command: "RunDRCWithRegions", clearance_mm: 0.15 });
    }
  });
  ui.setOnDrcNavigate((direction) => {
    const region = direction === "next" ? scene.nextDrcRegion() : scene.prevDrcRegion();
    if (region) {
      renderer.fitToBounds(region.bounds, 0.3);
      for (const [layerId, _visible] of scene.layerVisible) {
        scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
      }
      ui.updateLayerVisibility(/* @__PURE__ */ new Set([region.layer_id]));
      ui.updateDrcPanel(scene.drcRegions.length, scene.drcCurrentIndex, region);
    }
  });
  ui.setOnClearDrc(() => {
    console.log("[DRC] Clearing DRC");
    scene.clearDrc();
    ui.resetDrcPanel();
    for (const [layerId, _visible] of scene.layerVisible) {
      scene.toggleLayerVisibility(layerId, true);
    }
    ui.refreshLayerLegend();
  });
  const initEnd = performance.now();
  console.log(`[INIT] Total initialization time: ${(initEnd - initStart).toFixed(1)}ms`);
  if (globalThis.gc) {
    setTimeout(() => {
      console.log("[INIT] Triggering manual GC");
      globalThis.gc();
    }, 5e3);
  }
  window.debugRender = (type) => {
    renderer.debugRenderType = type;
    scene.state.needsDraw = true;
    console.log(`[Debug] Set render type to: ${type}`);
  };
  window.logFrame = () => {
    renderer.debugLogNextFrame = true;
    scene.state.needsDraw = true;
  };
  function loop() {
    const wasNeedsDraw = scene.state.needsDraw;
    renderer.render();
    if (debugOverlay && wasNeedsDraw) {
      debugOverlay.render();
    }
    ui.updateStats();
    ui.updateHighlightPosition();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  if (isVSCodeWebview && vscode2) {
    setInterval(() => {
      vscode2.postMessage({ command: "GetMemory" });
    }, 2e3);
  }
}
init().catch((error) => {
  const errorMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const errorStack = error instanceof Error ? error.stack : "";
  console.error(`[INIT FAILED] ${errorMsg}`);
  if (errorStack) {
    console.error(`[INIT FAILED] Stack: ${errorStack}`);
  }
  const panel = document.getElementById("ui");
  if (panel) {
    const message = document.createElement("div");
    message.style.marginTop = "8px";
    message.style.color = "#ff6b6b";
    message.textContent = errorMsg;
    panel.appendChild(message);
  }
});

import basicShaderCode from "./shaders/basic.wgsl?raw";
import basicNoAlphaShaderCode from "./shaders/basic_noalpha.wgsl?raw";
import instancedShaderCode from "./shaders/instanced.wgsl?raw";
import instancedRotShaderCode from "./shaders/instanced_rot.wgsl?raw";
import { Scene } from "./Scene";
import { LayerColor, GPUBufferInfo } from "./types";

export class Renderer {
  public canvas: HTMLCanvasElement;
  public device!: GPUDevice;
  public context!: GPUCanvasContext;
  
  private pipelineNoAlpha!: GPURenderPipeline;
  private pipelineWithAlpha!: GPURenderPipeline;
  private pipelineInstanced!: GPURenderPipeline;
  private pipelineInstancedRot!: GPURenderPipeline;
  
  private canvasFormat!: GPUTextureFormat;
  private configuredWidth = 0;
  private configuredHeight = 0;
  
  private uniformData = new Float32Array(16);
  
  public lastVertexCount = 0;
  public lastIndexCount = 0;
  public frameCount = 0;
  public lastFpsUpdate = performance.now();
  public lastFps = 0;
  
  private scene: Scene;
  
  // Debug stats
  public gpuMemoryBytes = 0;
  public gpuBuffers: GPUBufferInfo[] = [];

  constructor(canvas: HTMLCanvasElement, scene: Scene) {
    this.canvas = canvas;
    this.scene = scene;
  }

  public async init() {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
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
    
    // Pass device and pipelines to Scene so it can load data
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

  private createPipelines() {
    const shaderModuleWithAlpha = this.device.createShaderModule({ code: basicShaderCode });
    const shaderModuleNoAlpha = this.device.createShaderModule({ code: basicNoAlphaShaderCode });
    const shaderModuleInstanced = this.device.createShaderModule({ code: instancedShaderCode });
    const shaderModuleInstancedRot = this.device.createShaderModule({ code: instancedRotShaderCode });

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
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            stepMode: "instance",
            attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }]
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
  }

  private wrapCreateBuffer(gpuDevice: GPUDevice) {
    if ((gpuDevice as unknown as { __wrappedCreateBuffer?: boolean }).__wrappedCreateBuffer) {
      return;
    }
    const original = gpuDevice.createBuffer.bind(gpuDevice);
    gpuDevice.createBuffer = ((descriptor: GPUBufferDescriptor) => {
      const buffer = original(descriptor);
      const size = descriptor.size ?? 0;
      this.gpuMemoryBytes += size;
      this.gpuBuffers.push({ buffer, size });
      return buffer;
    }) as typeof gpuDevice.createBuffer;
    (gpuDevice as unknown as { __wrappedCreateBuffer: boolean }).__wrappedCreateBuffer = true;
  }

  public configureSurface() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    
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

  private updateUniforms() {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    
    const flipX = state.flipX ? -1 : 1;
    const flipY = state.flipY ? -1 : 1;
    const scaleX = (2 * state.zoom) / width;
    const scaleY = (2 * state.zoom) / height;
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

  private selectLODForZoom(zoom: number): number {
    if (zoom >= 10) return 0;
    if (zoom >= 5) return 1;
    if (zoom >= 2) return 2;
    if (zoom >= 0.5) return 3;
    return 4;
  }

  public screenToWorld(cssX: number, cssY: number): { x: number; y: number } {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    
    const fx = state.flipX ? -1 : 1;
    const fy = state.flipY ? -1 : 1;
    const scaleX = (2 * state.zoom) / width;
    const scaleY = (2 * state.zoom) / height;
    const xNdc = (2 * cssX) / Math.max(1, this.canvas.clientWidth) - 1;
    const yNdc = 1 - (2 * cssY) / Math.max(1, this.canvas.clientHeight);

    const worldX = ((xNdc / fx + 1) / scaleX) - width / 2 - state.panX;
    const worldY = ((1 - yNdc * fy) / scaleY) - height / 2 - state.panY;
    return { x: worldX, y: worldY };
  }

  public render() {
    if (!this.scene.state.needsDraw) {
      return;
    }
    this.scene.state.needsDraw = false;
    this.configureSurface();
    this.updateUniforms();

    const currentLOD = this.selectLODForZoom(this.scene.state.zoom);
    
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

    for (const layerId of this.scene.layerOrder) {
      if (this.scene.layerVisible.get(layerId) === false) continue;
      
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        if (data.layerId !== layerId) continue;
        if (renderKey.endsWith('_instanced')) continue;
        
        if (data.shaderType === 'instanced_rot') {
          const totalLODs = data.lodBuffers.length;
          const numShapes = totalLODs / 3;
          const lodStartIdx = currentLOD * numShapes;
          const lodEndIdx = lodStartIdx + numShapes;
          
          pass.setPipeline(this.pipelineInstancedRot);
          
          for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
            const vb = data.lodBuffers[idx];
            const count = data.lodVertexCounts[idx];
            const instanceBuf = data.lodInstanceBuffers?.[idx];
            const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
            
            if (!vb || !count || !instanceBuf || instanceCount === 0) continue;
            
            pass.setVertexBuffer(0, vb);
            pass.setVertexBuffer(1, instanceBuf);
            
            const layerColor = this.scene.getLayerColor(data.layerId);
            this.uniformData.set(layerColor, 0);
            this.device.queue.writeBuffer(data.uniformBuffer, 0, this.uniformData);
            pass.setBindGroup(0, data.bindGroup);
            
            const ib = data.lodIndexBuffers?.[idx];
            const ic = data.lodIndexCounts?.[idx] ?? 0;
            if (ib && ic > 0) {
              pass.setIndexBuffer(ib, "uint32");
              pass.drawIndexed(ic, instanceCount);
              totalIndices += ic * instanceCount;
            } else {
              pass.draw(count, instanceCount);
            }
          }
          continue;
        }
        
        const actualLOD = Math.min(currentLOD, data.lodBuffers.length - 1);
        const vb = data.lodBuffers[actualLOD];
        const count = data.lodVertexCounts[actualLOD];
        if (!vb || !count) continue;
        totalVertices += count;

        let usePipeline: GPURenderPipeline;
        if (data.shaderType === 'batch') {
          usePipeline = this.pipelineNoAlpha;
        } else if (renderKey.endsWith('_instanced')) {
          usePipeline = this.pipelineInstanced;
        } else {
          usePipeline = this.pipelineWithAlpha;
        }
        
        pass.setPipeline(usePipeline);
        pass.setVertexBuffer(0, vb);
        
        if (renderKey.endsWith('_instanced')) {
          const instanceBuf = data.lodInstanceBuffers?.[actualLOD];
          const instanceCount = data.lodInstanceCounts?.[actualLOD] ?? 0;
          
          if (instanceBuf && instanceCount > 0) {
            pass.setVertexBuffer(1, instanceBuf);
            
            const layerColor = this.scene.getLayerColor(data.layerId);
            this.uniformData.set(layerColor, 0);
            this.device.queue.writeBuffer(data.uniformBuffer, 0, this.uniformData);
            pass.setBindGroup(0, data.bindGroup);
            
            const ib = data.lodIndexBuffers?.[actualLOD] ?? null;
            const ic = data.lodIndexCounts?.[actualLOD] ?? 0;
            if (ib && ic > 0) {
              pass.setIndexBuffer(ib, "uint32");
              pass.drawIndexed(ic, instanceCount);
              totalIndices += ic * instanceCount;
            } else {
              pass.draw(count, instanceCount);
            }
          }
        } else {
          if (data.shaderType !== 'batch') {
            const alphaBuf = data.lodAlphaBuffers[actualLOD];
            if (alphaBuf) {
              pass.setVertexBuffer(1, alphaBuf);
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
    }
    
    const anyLayerVisible = Array.from(this.scene.layerVisible.values()).some(v => v);
    if (this.scene.viasVisible && anyLayerVisible) {
      const viaColor: LayerColor = [1.0, 0.9, 0.25, 1.0];
      
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        if (!renderKey.endsWith('_instanced')) continue;
        
        const totalLODs = data.lodBuffers.length;
        const numSizes = totalLODs / 3;
        
        if (currentLOD >= 3) continue;
        
        const lodStartIdx = currentLOD * numSizes;
        const lodEndIdx = lodStartIdx + numSizes;
        
        for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
          const vb = data.lodBuffers[idx];
          const count = data.lodVertexCounts[idx];
          
          if (!vb || !count || count === 0) continue;
          
          const instanceBuf = data.lodInstanceBuffers?.[idx];
          const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
          
          if (!instanceBuf || instanceCount === 0) continue;
          
          pass.setPipeline(this.pipelineInstanced);
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
    
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.lastVertexCount = totalVertices;
    this.lastIndexCount = totalIndices;

    this.frameCount += 1;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.lastFps = (this.frameCount * 1000) / (now - this.lastFpsUpdate);
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }
}

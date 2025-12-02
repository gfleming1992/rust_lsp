import basicShaderCode from "./shaders/basic.wgsl?raw";
import basicNoAlphaShaderCode from "./shaders/basic_noalpha.wgsl?raw";
import instancedShaderCode from "./shaders/instanced.wgsl?raw";
import instancedRotShaderCode from "./shaders/instanced_rot.wgsl?raw";
import drcOverlayShaderCode from "./shaders/drc_overlay.wgsl?raw";
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
  private pipelineDrcOverlay!: GPURenderPipeline;
  
  private canvasFormat!: GPUTextureFormat;
  private configuredWidth = 0;
  private configuredHeight = 0;
  
  // Uniform data layout: color(4) + m0(4) + m1(4) + m2(4) + moveOffset(4) = 20 floats
  private uniformData = new Float32Array(20);
  
  // DRC overlay bind group and uniform buffer
  // Uniforms: v0(vec4) + v1(vec4) + v2(vec4) + stripeColor(vec4) = 64 bytes
  private drcUniformBuffer!: GPUBuffer;
  private drcUniformData = new Float32Array(16); // 4 vec4s
  private drcBindGroup!: GPUBindGroup;
  
  public lastVertexCount = 0;
  public lastIndexCount = 0;
  public frameCount = 0;
  public lastFpsUpdate = performance.now();
  public lastFps = 0;
  
  private scene: Scene;
  
  // Debug stats
  public gpuMemoryBytes = 0;
  public gpuBuffers: GPUBufferInfo[] = [];
  
  // Debug control
  public debugLogNextFrame = false;

  // Loading state - keep canvas black until first layer batch is loaded
  private isLoading = true;

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
          },
          { // Visibility buffer
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
          { // Visibility buffer
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
            arrayStride: 3 * Float32Array.BYTES_PER_ELEMENT, // Changed to 3 floats (x, y, packed)
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

    // DRC overlay pipeline with stripe pattern
    const shaderModuleDrcOverlay = this.device.createShaderModule({ code: drcOverlayShaderCode });
    
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

    // Create DRC uniform buffer and bind group
    // 4 x vec4<f32> = 64 bytes (v0, v1, v2, stripeColor)
    this.drcUniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.drcBindGroup = this.device.createBindGroup({
      layout: this.pipelineDrcOverlay.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.drcUniformBuffer }
      }]
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
      const bufferInfo = { buffer, size };
      this.gpuBuffers.push(bufferInfo);
      
      // Track buffer destruction to update memory stats
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
    
    // Move offset (xy = offset, zw = unused padding)
    const moveOffset = this.scene.getMoveOffset();
    this.uniformData[16] = moveOffset.x;
    this.uniformData[17] = moveOffset.y;
    this.uniformData[18] = 0;
    this.uniformData[19] = 0;
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

  public worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const state = this.scene.state;
    
    const fx = state.flipX ? -1 : 1;
    const fy = state.flipY ? -1 : 1;
    const scaleX = (2 * state.zoom) / width;
    const scaleY = (2 * state.zoom) / height;

    // Inverse of screenToWorld
    // worldX = ((xNdc / fx + 1) / scaleX) - width / 2 - state.panX
    // worldX + width/2 + state.panX = (xNdc / fx + 1) / scaleX
    // (worldX + width/2 + state.panX) * scaleX = xNdc / fx + 1
    // (worldX + width/2 + state.panX) * scaleX - 1 = xNdc / fx
    // ((worldX + width/2 + state.panX) * scaleX - 1) * fx = xNdc
    
    const xNdc = ((worldX + width / 2 + state.panX) * scaleX - 1) * fx;
    const yNdc = (1 - (worldY + height / 2 + state.panY) * scaleY) / fy;

    // xNdc = (2 * cssX) / clientWidth - 1
    // xNdc + 1 = (2 * cssX) / clientWidth
    // (xNdc + 1) * clientWidth / 2 = cssX
    
    const cssX = (xNdc + 1) * Math.max(1, this.canvas.clientWidth) / 2;
    const cssY = (1 - yNdc) * Math.max(1, this.canvas.clientHeight) / 2;
    
    return { x: cssX, y: cssY };
  }

  public render() {
    if (!this.scene.state.needsDraw) {
      return;
    }
    this.scene.state.needsDraw = false;
    this.configureSurface();
    this.updateUniforms();

    if ((window as any).debugLogNextFrame) {
        this.debugLogNextFrame = true;
        (window as any).debugLogNextFrame = false;
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
    
    // If still loading, just clear to black and skip rendering
    if (this.isLoading) {
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return;
    }

    for (const layerId of this.scene.layerOrder) {
      if (this.scene.layerVisible.get(layerId) === false) continue;
      
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        if (data.layerId !== layerId) continue;

        // Handle instanced rendering (both rot and non-rot)
        if (data.shaderType === 'instanced' || data.shaderType === 'instanced_rot') {
          const totalLODs = data.lodBuffers.length;
          const numShapes = totalLODs / 3;
          
          // Clamp LOD to max available (2)
          const effectiveLOD = Math.min(currentLOD, 2);
          
          const lodStartIdx = effectiveLOD * numShapes;
          const lodEndIdx = lodStartIdx + numShapes;
          
          const pipeline = data.shaderType === 'instanced_rot' 
             ? this.pipelineInstancedRot 
             : this.pipelineInstanced;
          
          pass.setPipeline(pipeline);
          
          for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
            const vb = data.lodBuffers[idx];
            const count = data.lodVertexCounts[idx];
            const instanceBuf = data.lodInstanceBuffers?.[idx];
            const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
            
            if (!vb || !count || !instanceBuf || instanceCount === 0) continue;
            
            if (this.debugLogNextFrame) {
                console.log(`[Render] Drawing instanced ${data.shaderType} layer=${layerId} idx=${idx} verts=${count} instances=${instanceCount}`);
            }

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

        if (this.debugLogNextFrame) {
            console.log(`[Render] Drawing batch ${data.shaderType} layer=${layerId} LOD=${actualLOD} verts=${count}`);
        }

        let usePipeline: GPURenderPipeline;
        if (data.shaderType === 'batch') {
          usePipeline = this.pipelineNoAlpha;
        } else {
          usePipeline = this.pipelineWithAlpha;
        }
        
        pass.setPipeline(usePipeline);
        pass.setVertexBuffer(0, vb);
        
        if (data.shaderType !== 'batch') {
            const alphaBuf = data.lodAlphaBuffers[actualLOD];
            if (alphaBuf) {
              pass.setVertexBuffer(1, alphaBuf);
            }
            // Bind visibility buffer for batch_colored (pipelineWithAlpha)
            const visBuf = data.lodVisibilityBuffers[actualLOD];
            if (visBuf) {
              pass.setVertexBuffer(2, visBuf);
              if (this.debugLogNextFrame && data.layerId === 'Mechanical 9') {
                console.log(`[Render] Binding visibility buffer to slot 2 for ${data.layerId}, LOD${actualLOD}`);
              }
            } else if (this.debugLogNextFrame && data.layerId === 'Mechanical 9') {
              console.log(`[Render] NO visibility buffer for ${data.layerId}, LOD${actualLOD}`);
            }
        } else {
            // Bind visibility buffer for batch (pipelineNoAlpha)
            const visBuf = data.lodVisibilityBuffers[actualLOD];
            if (visBuf) {
              pass.setVertexBuffer(1, visBuf);
              if (this.debugLogNextFrame && data.layerId === 'Mechanical 9') {
                console.log(`[Render] Binding visibility buffer to slot 1 for ${data.layerId}, LOD${actualLOD}`);
              }
            } else if (this.debugLogNextFrame && data.layerId === 'Mechanical 9') {
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
    
    // Gold via/PTH overlay - render gold rings on top of visible vias
    const anyLayerVisible = Array.from(this.scene.layerVisible.values()).some(v => v);
    if (this.scene.viasVisible && anyLayerVisible) {
      const viaColor: LayerColor = [1.0, 0.84, 0.0, 1.0]; // Gold color
      
      for (const [renderKey, data] of this.scene.layerRenderData.entries()) {
        // Only process instanced geometry (vias use 'instanced' shader)
        if (data.shaderType !== 'instanced') continue;
        
        // Skip if parent layer is not visible
        if (this.scene.layerVisible.get(data.layerId) === false) continue;
        
        const totalLODs = data.lodBuffers.length;
        const numShapes = totalLODs / 3;
        
        // Clamp LOD to max available (2)
        const effectiveLOD = Math.min(currentLOD, 2);
        
        const lodStartIdx = effectiveLOD * numShapes;
        const lodEndIdx = lodStartIdx + numShapes;
        
        pass.setPipeline(this.pipelineInstanced);
        
        for (let idx = lodStartIdx; idx < lodEndIdx && idx < totalLODs; idx++) {
          const vb = data.lodBuffers[idx];
          const count = data.lodVertexCounts[idx];
          
          if (!vb || !count || count === 0) continue;
          
          const instanceBuf = data.lodInstanceBuffers?.[idx];
          const instanceCount = data.lodInstanceCounts?.[idx] ?? 0;
          
          if (!instanceBuf || instanceCount === 0) continue;
          
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
    
    // DRC overlay - render stripe pattern over violation triangles
    if (this.scene.drcEnabled && this.scene.drcVertexBuffer && this.scene.drcTriangleCount > 0) {
      // Get current DRC region to determine layer color
      const currentRegion = this.scene.getCurrentDrcRegion();
      let stripeColor: [number, number, number, number] = [1.0, 0.15, 0.15, 0.85]; // Default: bright red
      
      if (currentRegion) {
        // Get layer color and compute contrasting stripe color
        const layerColor = this.scene.getLayerColor(currentRegion.layer_id);
        stripeColor = this.getContrastingStripeColor(layerColor);
        if (this.debugLogNextFrame) {
          console.log(`[DRC] Layer ${currentRegion.layer_id} color: ${layerColor}, stripe: ${stripeColor}`);
        }
      }
      
      // Copy view matrix (indices 4-15 from uniformData = 12 floats = 3 vec4s)
      this.drcUniformData.set(this.uniformData.subarray(4, 16), 0);
      // Set stripe color (indices 12-15 = 4th vec4)
      this.drcUniformData[12] = stripeColor[0];
      this.drcUniformData[13] = stripeColor[1];
      this.drcUniformData[14] = stripeColor[2];
      this.drcUniformData[15] = stripeColor[3];
      
      this.device.queue.writeBuffer(this.drcUniformBuffer, 0, this.drcUniformData);
      
      pass.setPipeline(this.pipelineDrcOverlay);
      pass.setBindGroup(0, this.drcBindGroup);
      pass.setVertexBuffer(0, this.scene.drcVertexBuffer);
      pass.draw(this.scene.drcTriangleCount * 3);
      
      if (this.debugLogNextFrame) {
        console.log(`[Render] DRC overlay: ${this.scene.drcTriangleCount} triangles, vertexBuffer size: ${this.scene.drcVertexBuffer.size}`);
        console.log(`[Render] DRC uniforms: v0=[${this.drcUniformData[0].toFixed(4)}, ${this.drcUniformData[1].toFixed(4)}, ${this.drcUniformData[2].toFixed(4)}, ${this.drcUniformData[3].toFixed(4)}]`);
        console.log(`[Render] DRC uniforms: stripeColor=[${this.drcUniformData[12].toFixed(2)}, ${this.drcUniformData[13].toFixed(2)}, ${this.drcUniformData[14].toFixed(2)}, ${this.drcUniformData[15].toFixed(2)}]`);
      }
    } else if (this.debugLogNextFrame) {
      console.log(`[Render] DRC overlay skipped: enabled=${this.scene.drcEnabled}, buffer=${!!this.scene.drcVertexBuffer}, triangles=${this.scene.drcTriangleCount}`);
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
    if (now - this.lastFpsUpdate >= 1000) {
      this.lastFps = (this.frameCount * 1000) / (now - this.lastFpsUpdate);
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }
  
  /**
   * Mark loading as complete - allows rendering to begin
   */
  public finishLoading() {
    this.isLoading = false;
    this.scene.state.needsDraw = true;
  }

  /**
   * Fit the camera to show a bounding box with some padding
   * bounds: [minX, minY, maxX, maxY] in world coordinates
   */
  public fitToBounds(bounds: [number, number, number, number], padding = 0.2) {
    const [minX, minY, maxX, maxY] = bounds;
    const regionWidth = maxX - minX;
    const regionHeight = maxY - minY;
    
    if (regionWidth <= 0 || regionHeight <= 0) {
      console.log('[fitToBounds] Invalid bounds:', bounds);
      return;
    }
    
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Use physical canvas dimensions (with DPR scaling)
    const width = this.canvas.width;
    const height = this.canvas.height;
    
    // Calculate zoom to fit the region with padding
    // From screenToWorld: worldX = ((xNdc / fx + 1) / scaleX) - width/2 - panX
    // where scaleX = (2 * zoom) / width
    // So: worldX = ((xNdc + 1) * width / (2 * zoom)) - width/2 - panX
    // When xNdc goes from -1 to 1, we cover regionWidth in world space
    // range(xNdc) = 2, so 2 * width / (2 * zoom) = width / zoom should equal regionWidth
    // zoom = width / regionWidth
    const paddingFactor = 1 - padding;
    const zoomX = (width * paddingFactor) / regionWidth;
    const zoomY = (height * paddingFactor) / regionHeight;
    const zoom = Math.min(zoomX, zoomY);
    
    // Calculate pan to center the region
    // From screenToWorld: worldX = ((xNdc / fx + 1) / scaleX) - width/2 - panX
    // At screen center (xNdc=0): worldX = (1 / scaleX) - width/2 - panX = width/(2*zoom) - width/2 - panX
    // We want worldX = centerX at screen center
    // centerX = width/(2*zoom) - width/2 - panX
    // panX = width/(2*zoom) - width/2 - centerX
    const panX = width / (2 * zoom) - width / 2 - centerX;
    const panY = height / (2 * zoom) - height / 2 - centerY;
    
    console.log(`[fitToBounds] Region: ${regionWidth.toFixed(2)} x ${regionHeight.toFixed(2)} mm at (${centerX.toFixed(2)}, ${centerY.toFixed(2)})`);
    console.log(`[fitToBounds] Canvas: ${width} x ${height} px, zoom: ${zoom.toFixed(2)}, pan: (${panX.toFixed(2)}, ${panY.toFixed(2)})`);
    
    const state = this.scene.state;
    state.zoom = zoom;
    state.panX = panX;
    state.panY = panY;
    state.needsDraw = true;
  }

  /**
   * Get a contrasting stripe color based on the layer color
   * Avoids colors too similar to: the layer color, and the fixed gold via color (1.0, 0.84, 0.0)
   */
  private getContrastingStripeColor(layerColor: LayerColor): [number, number, number, number] {
    const [r, g, b, _a] = layerColor;
    
    // Calculate perceived luminance
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    
    // Check if the layer is predominantly red
    const isReddish = r > 0.5 && g < 0.4 && b < 0.4;
    
    // Check if the layer is predominantly blue (like copper layers)
    const isBluish = b > 0.5 && r < 0.5 && g < 0.6;
    
    // Check if the layer is very dark
    const isDark = luminance < 0.3;
    
    // Check if the layer is very bright
    const isBright = luminance > 0.7;
    
    // Check if the layer is yellowish/gold (avoid conflict with via gold)
    const isYellowish = r > 0.7 && g > 0.6 && b < 0.4;
    
    if (isReddish) {
      // Use cyan (opposite of red) for red layers
      return [0.0, 1.0, 1.0, 0.9];
    } else if (isBluish) {
      // For blue layers (common copper), use bright magenta/pink - avoids gold conflict
      return [1.0, 0.2, 0.6, 0.9];
    } else if (isYellowish) {
      // For yellow/gold layers, use bright magenta
      return [1.0, 0.0, 0.8, 0.9];
    } else if (isDark) {
      // Use bright magenta for dark layers - avoids gold conflict
      return [1.0, 0.3, 0.7, 0.9];
    } else if (isBright) {
      // Use dark magenta for bright layers
      return [0.8, 0.0, 0.4, 0.9];
    } else {
      // Default: bright red
      return [1.0, 0.15, 0.15, 0.85];
    }
  }
}

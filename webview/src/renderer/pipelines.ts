import { LayerColor } from "../types";

/// <reference types="@webgpu/types" />

/** Blend state for standard alpha blending */
const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
};

export interface Pipelines {
  noAlpha: GPURenderPipeline;
  withAlpha: GPURenderPipeline;
  instanced: GPURenderPipeline;
  instancedRot: GPURenderPipeline;
  drcOverlay: GPURenderPipeline;
}

export interface DrcResources {
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

/** Create all render pipelines for the PCB viewer */
export function createPipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  shaders: {
    basic: string;
    basicNoAlpha: string;
    instanced: string;
    instancedRot: string;
    drcOverlay: string;
  }
): { pipelines: Pipelines; drcResources: DrcResources } {
  const moduleWithAlpha = device.createShaderModule({ code: shaders.basic });
  const moduleNoAlpha = device.createShaderModule({ code: shaders.basicNoAlpha });
  const moduleInstanced = device.createShaderModule({ code: shaders.instanced });
  const moduleInstancedRot = device.createShaderModule({ code: shaders.instancedRot });
  const moduleDrcOverlay = device.createShaderModule({ code: shaders.drcOverlay });

  const pipelineWithAlpha = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: moduleWithAlpha,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: "float32" }] } // visibility
      ]
    },
    fragment: {
      module: moduleWithAlpha,
      entryPoint: "fs_main",
      targets: [{ format, blend: ALPHA_BLEND }]
    },
    primitive: { topology: "triangle-list" }
  });

  const pipelineNoAlpha = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: moduleNoAlpha,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] } // visibility
      ]
    },
    fragment: {
      module: moduleNoAlpha,
      entryPoint: "fs_main",
      targets: [{ format, blend: ALPHA_BLEND }]
    },
    primitive: { topology: "triangle-list" }
  });

  const pipelineInstanced = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: moduleInstanced,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] }
      ]
    },
    fragment: {
      module: moduleInstanced,
      entryPoint: "fs_main",
      targets: [{ format, blend: ALPHA_BLEND }]
    },
    primitive: { topology: "triangle-list" }
  });

  const pipelineInstancedRot = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: moduleInstancedRot,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] }
      ]
    },
    fragment: {
      module: moduleInstancedRot,
      entryPoint: "fs_main",
      targets: [{ format, blend: ALPHA_BLEND }]
    },
    primitive: { topology: "triangle-list" }
  });

  const pipelineDrcOverlay = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: moduleDrcOverlay,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }
      ]
    },
    fragment: {
      module: moduleDrcOverlay,
      entryPoint: "fs_main",
      targets: [{ format, blend: ALPHA_BLEND }]
    },
    primitive: { topology: "triangle-list" }
  });

  // DRC uniform buffer (4 x vec4<f32> = 64 bytes)
  const drcUniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const drcBindGroup = device.createBindGroup({
    layout: pipelineDrcOverlay.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: drcUniformBuffer } }]
  });

  return {
    pipelines: {
      noAlpha: pipelineNoAlpha,
      withAlpha: pipelineWithAlpha,
      instanced: pipelineInstanced,
      instancedRot: pipelineInstancedRot,
      drcOverlay: pipelineDrcOverlay
    },
    drcResources: {
      uniformBuffer: drcUniformBuffer,
      bindGroup: drcBindGroup
    }
  };
}

/**
 * Get a contrasting stripe color for DRC overlay based on layer color.
 * Avoids colors too similar to the layer or the fixed gold via color.
 */
export function getContrastingStripeColor(layerColor: LayerColor): [number, number, number, number] {
  const [r, g, b] = layerColor;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  
  const isReddish = r > 0.5 && g < 0.4 && b < 0.4;
  const isBluish = b > 0.5 && r < 0.5 && g < 0.6;
  const isDark = luminance < 0.3;
  const isBright = luminance > 0.7;
  const isYellowish = r > 0.7 && g > 0.6 && b < 0.4;
  
  if (isReddish) return [0.0, 1.0, 1.0, 0.9];      // Cyan for red
  if (isBluish) return [1.0, 0.2, 0.6, 0.9];       // Magenta/pink for blue
  if (isYellowish) return [1.0, 0.0, 0.8, 0.9];   // Magenta for yellow/gold
  if (isDark) return [1.0, 0.3, 0.7, 0.9];         // Bright magenta for dark
  if (isBright) return [0.8, 0.0, 0.4, 0.9];       // Dark magenta for bright
  return [1.0, 0.15, 0.15, 0.85];                   // Default red
}

/** Select LOD level based on zoom */
export function selectLODForZoom(zoom: number): number {
  if (zoom >= 10) return 0;
  if (zoom >= 5) return 1;
  if (zoom >= 2) return 2;
  if (zoom >= 0.5) return 3;
  return 4;
}

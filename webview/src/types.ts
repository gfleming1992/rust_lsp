
export type LayerColor = [number, number, number, number];

export interface LayerInfo {
  id: string;
  name: string;
  defaultColor: LayerColor;
}

// Geometry data for a specific shader type at a specific LOD level
export interface GeometryLOD {
  vertexData: number[] | Float32Array;  // Raw Float32 array
  vertexCount: number;
  indexData?: number[] | Uint32Array;  // Raw Uint32 array
  indexCount?: number;
  instanceData?: number[] | Float32Array;  // Raw Float32 array: instanced=2 floats/instance (x,y), instanced_rot=3 floats/instance (x,y,rotation)
  instanceCount?: number;
  alphaData?: string;  // Optional base64-encoded per-vertex alpha values (1 float per vertex)
}

export interface ShaderGeometry {
  basic?: GeometryLOD[];           // For basic.wgsl
  instanced?: GeometryLOD[];       // For instanced.wgsl
  instanced_colored?: GeometryLOD[]; // For instanced_colored.wgsl
  instanced_rot?: GeometryLOD[];   // For instanced_rot.wgsl
  instanced_rot_colored?: GeometryLOD[]; // For instanced_rot_colored.wgsl
  batch?: GeometryLOD[];           // For basic_noalpha.wgsl
  batch_colored?: GeometryLOD[];   // For basic.wgsl
  batch_instanced?: GeometryLOD[]; // For batch_instanced.wgsl
  batch_instanced_rot?: GeometryLOD[]; // For batch_instanced_rot.wgsl
}

export interface LayerJSON {
  layerId: string;
  layerName: string;
  defaultColor: LayerColor;
  geometry: ShaderGeometry;  // Organized by shader type, then by LOD
}

export interface ViewerState {
  panX: number;
  panY: number;
  zoom: number;
  flipX: boolean;
  flipY: boolean;
  dragging: boolean;
  dragButton: number | null;
  lastX: number;
  lastY: number;
  needsDraw: boolean;
}

export interface StartupTimings {
  fetchStart: number;
  parseEnd: number;
  rebuildStart: number;
  rebuildEnd: number;
  firstDraw: number;
}

export interface GPUBufferInfo {
  buffer: GPUBuffer;
  size: number;
}

// Minimal per-layer render data
export interface LayerRenderData {
  layerId: string;
  shaderType: keyof ShaderGeometry; // Which shader type this layer uses
  lodBuffers: GPUBuffer[];
  lodAlphaBuffers: (GPUBuffer | null)[];
  lodInstanceBuffers?: GPUBuffer[]; // For instanced geometry
  lodVertexCounts: number[];
  lodInstanceCounts?: number[]; // For instanced geometry
  lodIndexBuffers?: (GPUBuffer | null)[];
  lodIndexCounts?: number[];
  currentLOD: number;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

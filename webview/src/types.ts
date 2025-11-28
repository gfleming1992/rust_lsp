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
  alphaData?: string | Float32Array;  // Optional: base64-encoded string (JSON) or typed array (binary) of per-vertex alpha values
  visibilityData?: string | Float32Array; // Optional: base64-encoded string (JSON) or typed array (binary) of per-vertex visibility values
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

export enum GeometryType {
  Batch = 0,
  BatchColored = 1,
  BatchInstanced = 2,
  BatchInstancedRot = 3,
  InstancedRotColored = 4,
  InstancedRot = 5,
  InstancedColored = 6,
  Instanced = 7,
  Basic = 8,
}

export interface ObjectRange {
  id: number; // u64 in Rust, but JS number (might lose precision if > 2^53, but IDs are small enough for now)
  // Actually, u64 IDs might be problematic in JS.
  // Rust sends them as numbers in JSON.
  // If they are large, they might be truncated.
  // My ID generation: layer_index(24) | type(4) | object_index(36).
  // 64 bits.
  // JS Number is double precision float (53 bits integer).
  // 24+4+36 = 64.
  // I should probably send IDs as strings from Rust.
  // But I'm sending `ObjectRange` struct which has `id: u64`.
  // Serde serializes u64 as number by default.
  // I should check if I need to change it to string.
  // For now, let's assume it works or I'll fix it later.
  layer_id: string;
  obj_type: number;
  vertex_ranges: [number, number][]; // (start, count)
  instance_index?: number;
  shape_index?: number; // For instanced geometry: which shape/LOD entry group this instance belongs to
  bounds: [number, number, number, number];
  net_name?: string; // Net name from IPC-2581 for highlighting connected shapes
}

// Minimal per-layer render data
export interface LayerRenderData {
  layerId: string;
  shaderType: keyof ShaderGeometry; // Which shader type this layer uses
  lodBuffers: GPUBuffer[];
  lodAlphaBuffers: (GPUBuffer | null)[];
  lodVisibilityBuffers: (GPUBuffer | null)[]; // Added
  lodInstanceBuffers?: GPUBuffer[]; // For instanced geometry
  
  // CPU-side copies for modification
  cpuVisibilityBuffers: (Float32Array | null)[];
  cpuInstanceBuffers: (Float32Array | null)[];

  lodVertexCounts: number[];
  lodInstanceCounts?: number[]; // For instanced geometry
  lodIndexBuffers?: (GPUBuffer | null)[];
  lodIndexCounts?: number[];
  currentLOD: number;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

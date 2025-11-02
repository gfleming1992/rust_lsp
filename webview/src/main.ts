import basicShaderCode from "./shaders/basic.wgsl?raw";
import { setupTestListeners } from "./tests";

// PCB Viewer with Multi-Shader Architecture
// ==========================================
// Supports 8 shader variants for optimal rendering performance:
//
// 1. basic.wgsl              - Simple shapes with optional per-vertex alpha (defaults to 1.0)
// 2. instanced.wgsl          - Repeated geometry (vias, drills) - translation only
// 3. instanced_colored.wgsl  - Repeated geometry with per-vertex alpha
// 4. instanced_rot.wgsl      - Repeated geometry with 0°/90°/180°/270° rotation (pads)
// 5. instanced_rot_colored.wgsl - Repeated geometry with rotation and per-vertex alpha
// 6. batch.wgsl              - Many unique items (traces) in one draw call
// 7. batch_instanced.wgsl    - Multiple types, each repeated (via types)
// 8. batch_instanced_rot.wgsl - Multiple types with rotation (pad types)
//
// Alpha Transparency:
// - basic.wgsl always accepts optional per-vertex alpha buffer (fills with 1.0 if not provided)
// - Batch shaders have built-in per-item packed colors with alpha
// - instanced_colored variants accept per-vertex alpha
// - Example: Polygon fills at 0.5 alpha, outlines at 1.0 alpha in same layer
//
// Rust populates the appropriate shader arrays based on geometry analysis

export type LayerColor = [number, number, number, number];

interface LayerInfo {
  id: string;
  name: string;
  defaultColor: LayerColor;
}

// Geometry data for a specific shader type at a specific LOD level
export interface GeometryLOD {
  vertexData: string;  // base64-encoded Float32Array binary data
  vertexCount: number;
  indexData?: string;  // Optional base64-encoded index buffer
  indexCount?: number;
  instanceData?: string;  // Optional base64-encoded instance data (for instanced shaders)
  instanceCount?: number;
  alphaData?: string;  // Optional base64-encoded per-vertex alpha values (1 float per vertex)
  // When alphaData is present, use the *_colored shader variant (e.g., basic_colored.wgsl)
  // RGB comes from layer's defaultColor, only alpha varies per-vertex
  // Example: polygon fills at 0.5 alpha, outlines at 1.0 alpha within same layer
  // Rust should populate alphaData when different vertices need different transparency
}

// Shader-specific geometry organized by LOD (5 levels: 0=highest detail, 4=lowest)
// Rust will pre-process geometry and populate the appropriate shader type arrays
// based on the geometry characteristics (unique vs repeated, needs rotation, etc.)
export interface ShaderGeometry {
  basic?: GeometryLOD[];           // For basic.wgsl - simple shapes with optional per-vertex alpha
  instanced?: GeometryLOD[];       // For instanced.wgsl - repeated identical geometry (vias, drill holes)
  instanced_colored?: GeometryLOD[]; // For instanced_colored.wgsl - repeated with per-vertex alpha
  instanced_rot?: GeometryLOD[];   // For instanced_rot.wgsl - repeated geometry with 0°/90°/180°/270° rotation (pads)
  instanced_rot_colored?: GeometryLOD[]; // For instanced_rot_colored.wgsl - repeated with rotation and per-vertex alpha
  batch?: GeometryLOD[];           // For batch.wgsl - many unique items in one draw (PCB traces)
  batch_instanced?: GeometryLOD[]; // For batch_instanced.wgsl - multiple types, each repeated (via types)
  batch_instanced_rot?: GeometryLOD[]; // For batch_instanced_rot.wgsl - multiple types with rotation (pad types)
}

export interface LayerJSON {
  layerId: string;
  layerName: string;
  defaultColor: LayerColor;
  geometry: ShaderGeometry;  // Organized by shader type, then by LOD
}

// Example: How Rust should populate geometry for a layer with polygon fills
// {
//   layerId: "TopCopper",
//   defaultColor: [0.85, 0.7, 0.2, 1],  // Base RGB color for the layer
//   geometry: {
//     basic: [  // All simple shapes (fills and outlines)
//       {
//         vertexData: "...",  // Triangle vertices for fills
//         vertexCount: 1000,
//         alphaData: "..."    // Optional: Alpha for each vertex [0.5, 0.5, ...] (1 float per vertex)
//                             // If omitted, defaults to 1.0 (full opacity)
//                             // Final color = [0.85, 0.7, 0.2, alpha] per vertex
//       },
//       {
//         vertexData: "...",  // Line vertices for outlines
//         vertexCount: 500
//         // No alphaData - defaults to alpha=1.0 (full opacity)
//       }
//     ]
//   }
// }

interface StartupTimings {
  fetchStart: number;
  parseEnd: number;
  rebuildStart: number;
  rebuildEnd: number;
  firstDraw: number;
}

interface GPUBufferInfo {
  buffer: GPUBuffer;
  size: number;
}

interface ViewerState {
  panX: number;
  panY: number;
  zoom: number;
  flipX: boolean;
  dragging: boolean;
  dragButton: number | null;
  lastX: number;
  lastY: number;
  needsDraw: boolean;
}

const ZOOM_SPEED = 0.005;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 500;
const STORAGE_KEY = "layerColorOverrides";
const BASE_PALETTE: LayerColor[] = [
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

const layerInfoMap = new Map<string, LayerInfo>();
const layerOrder: string[] = [];
const layerColors = new Map<string, LayerColor>();
const layerVisible = new Map<string, boolean>();
const colorOverrides = new Map<string, LayerColor>();

let vertices: Float32Array = new Float32Array();
let vertexCount = 0;
let lodBuffers: GPUBuffer[] = [];  // Array of 5 vertex buffers (one per LOD)
let lodAlphaBuffers: (GPUBuffer | null)[] = []; // Parallel array for per-vertex alpha buffers
let lodVertexCounts: number[] = [];  // Vertex counts per LOD
let currentLOD = 0;  // Active LOD index (0-4)

const uniformData = new Float32Array(16);

const state: ViewerState = {
  panX: 0,
  panY: 0,
  zoom: 1,
  flipX: false,
  dragging: false,
  dragButton: null,
  lastX: 0,
  lastY: 0,
  needsDraw: true
};

const startup: StartupTimings = {
  fetchStart: performance.now(),
  parseEnd: 0,
  rebuildStart: 0,
  rebuildEnd: 0,
  firstDraw: 0
};

let canvas: HTMLCanvasElement;
let coordOverlayEl: HTMLDivElement | null = null;
let layersEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let lastWidthEl: HTMLSpanElement | null = null;
let fpsEl: HTMLSpanElement | null = null;
let debugLogEl: HTMLDivElement | null = null;

let device: GPUDevice;
let context: GPUCanvasContext;
let pipeline: GPURenderPipeline;
let vertexBuffer: GPUBuffer;
let uniformBuffer: GPUBuffer;
let bindGroup: GPUBindGroup;
let canvasFormat: GPUTextureFormat;

let configuredWidth = 0;
let configuredHeight = 0;

let gpuMemoryBytes = 0;
const gpuBuffers: GPUBufferInfo[] = [];

let frameCount = 0;
let lastFpsUpdate = performance.now();
let lastFps = 0;
let lastStatsUpdate = 0;

let haveMouse = false;
let lastMouseX = 0;
let lastMouseY = 0;

function hashStr(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function interceptConsoleLog(target: HTMLDivElement | null) {
  if (!target) {
    return;
  }
  // Disabled: Don't intercept console.log to UI, only log to browser console
  // This allows AI agent to see all logs when running npm run dev
  console.log("[LOGGING] Browser DevTools console is the primary log output");
}

function wrapCreateBuffer(gpuDevice: GPUDevice) {
  if ((gpuDevice as unknown as { __wrappedCreateBuffer?: boolean }).__wrappedCreateBuffer) {
    return;
  }
  const original = gpuDevice.createBuffer.bind(gpuDevice);
  gpuDevice.createBuffer = ((descriptor: GPUBufferDescriptor) => {
    const buffer = original(descriptor);
    const size = descriptor.size ?? 0;
    gpuMemoryBytes += size;
    gpuBuffers.push({ buffer, size });
    return buffer;
  }) as typeof gpuDevice.createBuffer;
  (gpuDevice as unknown as { __wrappedCreateBuffer: boolean }).__wrappedCreateBuffer = true;
}

function getLayerInfo(id: string): LayerInfo | undefined {
  return layerInfoMap.get(id);
}

function registerLayerInfo(layerJson: LayerJSON) {
  const id = layerJson.layerId;
  const name = layerJson.layerName || id;
  const defaultColor = [...(layerJson.defaultColor ?? [0.8, 0.8, 0.8, 1])] as LayerColor;
  layerInfoMap.set(id, { id, name, defaultColor });
  if (!layerOrder.includes(id)) {
    layerOrder.push(id);
  }
  if (!layerColors.has(id)) {
    layerColors.set(id, [...defaultColor] as LayerColor);
  }
  if (!layerVisible.has(id)) {
    layerVisible.set(id, true);
  }
}

function getLayerColor(layerId: string): LayerColor {
  if (!layerColors.has(layerId)) {
    const layer = getLayerInfo(layerId);
    let base: LayerColor;
    if (layer) {
      base = [...layer.defaultColor] as LayerColor;
    } else {
      const paletteColor = BASE_PALETTE[hashStr(layerId) % BASE_PALETTE.length];
      base = [...paletteColor] as LayerColor;
    }
    if (colorOverrides.has(layerId)) {
      base = [...colorOverrides.get(layerId)!] as LayerColor;
    }
    layerColors.set(layerId, base);
    if (!layerVisible.has(layerId)) {
      layerVisible.set(layerId, true);
    }
  }
  return layerColors.get(layerId)!;
}

function saveColorOverride(layerId: string, color: LayerColor) {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, LayerColor>;
    stored[layerId] = color;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    console.error("Failed to save color override", error);
  }
}

function removeColorOverride(layerId: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, LayerColor>;
    delete stored[layerId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    console.error("Failed to remove color override", error);
  }
}

function loadColorOverrides() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, LayerColor>;
    for (const [layerId, color] of Object.entries(stored)) {
      if (Array.isArray(color) && color.length === 4) {
        colorOverrides.set(layerId, [...color] as LayerColor);
        layerColors.set(layerId, [...color] as LayerColor);
      }
    }
  } catch (error) {
    console.error("Failed to load color overrides", error);
  }
}

function loadLayerData(layerJson: LayerJSON) {
  // Destroy old buffers
  for (const buffer of lodBuffers) {
    buffer?.destroy();
  }
  for (const a of lodAlphaBuffers) {
    if (a) a.destroy();
  }
  lodBuffers = [];
  lodVertexCounts = [];
  lodAlphaBuffers = [];
  
  // Register layer metadata
  registerLayerInfo(layerJson);
  startup.rebuildStart = performance.now();
  
  // Use priority order for geometry types: prefer batch (most optimized), fall back to basic
  const geometryPriority: Array<[keyof ShaderGeometry, GeometryLOD[] | undefined]> = [
    ["batch", layerJson.geometry.batch],
    ["batch_instanced", layerJson.geometry.batch_instanced],
    ["batch_instanced_rot", layerJson.geometry.batch_instanced_rot],
    ["instanced_rot_colored", layerJson.geometry.instanced_rot_colored],
    ["instanced_rot", layerJson.geometry.instanced_rot],
    ["instanced_colored", layerJson.geometry.instanced_colored],
    ["instanced", layerJson.geometry.instanced],
    ["basic", layerJson.geometry.basic]
  ];
  
  let geometryLODs: GeometryLOD[] = [];
  let currentShaderType: string | null = null;
  for (const [shaderKey, lods] of geometryPriority) {
    if (lods && lods.length) {
      geometryLODs = lods;
      currentShaderType = shaderKey;
      break;
    }
  }
  
  if (geometryLODs.length === 0) {
    console.warn(`No geometry data found for layer ${layerJson.layerId}`);
    return;
  }
  
  // Load all LOD levels for the selected shader type
  for (let i = 0; i < geometryLODs.length; i++) {
    const lod = geometryLODs[i];
    if (!lod) {
      console.warn(`Missing LOD ${i} for layer ${layerJson.layerId}`);
      continue;
    }
    
    // Decode base64 to Float32Array
    const binaryString = atob(lod.vertexData);
    const bytes = new Uint8Array(binaryString.length);
    for (let j = 0; j < binaryString.length; j++) {
      bytes[j] = binaryString.charCodeAt(j);
    }
    const lodVertices = new Float32Array(bytes.buffer);
    
    // Create GPU buffer for this LOD
    const buffer = device.createBuffer({
      size: lodVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(buffer.getMappedRange()).set(lodVertices);
    buffer.unmap();
    
    lodBuffers.push(buffer);
    lodVertexCounts.push(lod.vertexCount);

    // Always create alpha buffer: use provided alphaData or fill with 1.0
    let alphaArr: Float32Array;
    if (lod.alphaData) {
      const alphaBin = atob(lod.alphaData);
      const alphaBytes = new Uint8Array(alphaBin.length);
      for (let k = 0; k < alphaBin.length; k++) alphaBytes[k] = alphaBin.charCodeAt(k);
      alphaArr = new Float32Array(alphaBytes.buffer);
    } else {
      // Fill with 1.0 (full opacity) for each vertex
      alphaArr = new Float32Array(lod.vertexCount);
      alphaArr.fill(1.0);
    }
    const alphaBuf = device.createBuffer({
      size: alphaArr.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Float32Array(alphaBuf.getMappedRange()).set(alphaArr);
    alphaBuf.unmap();
    lodAlphaBuffers.push(alphaBuf);
  }
  
  // Set LOD 0 as default
  currentLOD = 0;
  vertexBuffer = lodBuffers[0];
  vertexCount = lodVertexCounts[0];
  
  console.log(`Loaded layer ${layerJson.layerId} with ${lodBuffers.length} LOD levels (${currentShaderType || "unknown"} geometry):`);
  lodVertexCounts.forEach((count, i) => {
    const kb = (lodBuffers[i]?.size || 0) / 1024;
    console.log(`  LOD${i}: ${count} vertices (${kb.toFixed(2)} KB)`);
  });
  
  startup.rebuildEnd = performance.now();
}

function applyLayerColor(layerId: string) {
  const color = getLayerColor(layerId);
  uniformData.set(color, 0);
  state.needsDraw = true;
}

function createLegendRow(layerId: string, color: LayerColor, visible: boolean): string {
  const rgb = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, 1)`;
  const layer = getLayerInfo(layerId);
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

function refreshLayerLegend() {
  if (!layersEl) {
    return;
  }
  const legendParts: string[] = [];
  legendParts.push(`
    <div style="margin-bottom:4px; display:flex; gap:4px; flex-wrap:wrap; font:11px sans-serif;">
      <button type="button" data-layer-action="all" style="padding:2px 6px;">All</button>
      <button type="button" data-layer-action="none" style="padding:2px 6px;">None</button>
      <button type="button" data-layer-action="invert" style="padding:2px 6px;">Invert</button>
    </div>
  `);

  // Iterate in layer order (most recent layer first)
  const entries = layerOrder.map((layerId) => [layerId, getLayerColor(layerId)] as const);

  legendParts.push(`<div>`);
  for (const [layerId, color] of entries) {
    const visible = layerVisible.get(layerId) !== false;
    legendParts.push(createLegendRow(layerId, color, visible));
  }
  legendParts.push(`</div>`);

  layersEl.innerHTML = legendParts.join("");

  layersEl.querySelectorAll("button[data-layer-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const action = (event.currentTarget as HTMLButtonElement).dataset.layerAction;
      if (action === "all") {
        for (const layerId of layerColors.keys()) {
          layerVisible.set(layerId, true);
        }
      } else if (action === "none") {
        for (const layerId of layerColors.keys()) {
          layerVisible.set(layerId, false);
        }
      } else if (action === "invert") {
        for (const layerId of layerColors.keys()) {
          layerVisible.set(layerId, !(layerVisible.get(layerId) !== false));
        }
      }
      refreshLayerLegend();
      scheduleDraw();
    });
  });

  layersEl.querySelectorAll("input[data-layer-toggle]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      const layerId = target.dataset.layerToggle;
      if (!layerId) return;
      layerVisible.set(layerId, target.checked);
      scheduleDraw();
    });
  });

  layersEl.querySelectorAll<HTMLButtonElement>("button[data-layer-color]").forEach((button) => {
    button.addEventListener("click", () => {
      const layerId = button.dataset.layerColor;
      if (!layerId) return;
      const current = getLayerColor(layerId);
      showColorPicker(layerId, current);
    });
  });
}

function showColorPicker(layerId: string, currentColor: LayerColor) {
  const existing = document.getElementById("colorPickerModal");
  existing?.remove();

  const modal = document.createElement("div");
  modal.id = "colorPickerModal";
  modal.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:10000;";

  const picker = document.createElement("div");
  picker.style.cssText = "background:#2b2b2b; padding:20px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5);";

  const rgbString = (r: number, g: number, b: number) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

  let html = `<div style="color:#fff; font:14px sans-serif; margin-bottom:12px;">Pick color for <strong>${layerId}</strong></div>`;
  html += `<div style="display:grid; grid-template-columns:repeat(16, 24px); gap:2px; margin-bottom:12px;">`;

  for (let i = 0; i < 16; i += 1) {
    const grey = i / 15;
    const rgb = rgbString(grey, grey, grey);
    html += `<div class="color-cell" data-color="${grey},${grey},${grey}" style="width:24px; height:24px; background:${rgb}; cursor:pointer; border:1px solid #444;"></div>`;
  }

  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const hue = (col / 16) * 360;
      const sat = 0.3 + (row / 11) * 0.7;
      const light = 0.3 + (col % 2) * 0.2 + (row % 3) * 0.15;

      const c = (1 - Math.abs(2 * light - 1)) * sat;
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
      const m = light - c / 2;

      let r = 0;
      let g = 0;
      let b = 0;

      if (hue < 60) { r = c; g = x; b = 0; }
      else if (hue < 120) { r = x; g = c; b = 0; }
      else if (hue < 180) { r = 0; g = c; b = x; }
      else if (hue < 240) { r = 0; g = x; b = c; }
      else if (hue < 300) { r = x; g = 0; b = c; }
      else { r = c; g = 0; b = x; }

      r += m; g += m; b += m;
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

  picker.querySelectorAll<HTMLDivElement>(".color-cell").forEach((cell) => {
    cell.addEventListener("click", (event) => {
      const colorStr = (event.currentTarget as HTMLDivElement).dataset.color;
      if (!colorStr) return;
      const [r, g, b] = colorStr.split(",").map(parseFloat);
      const color: LayerColor = [r, g, b, 1];
      layerColors.set(layerId, color);
      colorOverrides.set(layerId, color);
      saveColorOverride(layerId, color);
      refreshLayerLegend();
      applyLayerColor(layerId);
      modal.remove();
    });
  });

  const applyButton = document.getElementById("applyCustomBtn");
  const hexInput = document.getElementById("hexColorInput") as HTMLInputElement | null;
  applyButton?.addEventListener("click", () => {
    if (!hexInput) return;
    const cleaned = hexInput.value.replace(/[^0-9a-fA-F]/g, "");
    if (cleaned.length === 6) {
      const r = parseInt(cleaned.slice(0, 2), 16) / 255;
      const g = parseInt(cleaned.slice(2, 4), 16) / 255;
      const b = parseInt(cleaned.slice(4, 6), 16) / 255;
      const color: LayerColor = [r, g, b, 1];
      layerColors.set(layerId, color);
      colorOverrides.set(layerId, color);
      saveColorOverride(layerId, color);
      refreshLayerLegend();
      applyLayerColor(layerId);
      modal.remove();
    }
  });

  const resetButton = document.getElementById("resetColorBtn");
  resetButton?.addEventListener("click", () => {
    layerColors.delete(layerId);
    colorOverrides.delete(layerId);
    removeColorOverride(layerId);
    refreshLayerLegend();
    applyLayerColor(layerId);
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

function screenToWorld(cssX: number, cssY: number): { x: number; y: number } {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const fx = state.flipX ? -1 : 1;
  const scaleX = (2 * state.zoom) / width;
  const scaleY = (2 * state.zoom) / height;
  const xNdc = (2 * cssX) / Math.max(1, canvas.clientWidth) - 1;
  const yNdc = 1 - (2 * cssY) / Math.max(1, canvas.clientHeight);

  const worldX = ((xNdc / fx + 1) / scaleX) - width / 2 - state.panX;
  const worldY = ((1 - yNdc) / scaleY) - height / 2 - state.panY;
  return { x: worldX, y: worldY };
}

function updateUniforms() {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const flipX = state.flipX ? -1 : 1;
  const scaleX = (2 * state.zoom) / width;
  const scaleY = (2 * state.zoom) / height;
  const offsetX = scaleX * (width / 2 + state.panX) - 1;
  const offsetY = 1 - scaleY * (height / 2 + state.panY);

  uniformData[4] = flipX * scaleX;
  uniformData[5] = 0;
  uniformData[6] = flipX * offsetX;
  uniformData[7] = 0;

  uniformData[8] = 0;
  uniformData[9] = -scaleY;
  uniformData[10] = offsetY;
  uniformData[11] = 0;

  uniformData[12] = 0;
  uniformData[13] = 0;
  uniformData[14] = 1;
  uniformData[15] = 0;
}

function configureSurface() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  if (width === configuredWidth && height === configuredHeight) {
    return;
  }
  configuredWidth = width;
  configuredHeight = height;
  context.configure({
    device,
    format: canvasFormat,
    alphaMode: "premultiplied",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });
  state.needsDraw = true;
}

function updateCoordOverlay() {
  if (!coordOverlayEl) return;
  if (!haveMouse) {
    coordOverlayEl.textContent = `x: -, y: -, zoom: ${state.zoom.toFixed(2)}, LOD: ${currentLOD}`;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(lastMouseX - rect.left, lastMouseY - rect.top);
  coordOverlayEl.textContent = `x: ${world.x.toFixed(2)}, y: ${world.y.toFixed(2)}, zoom: ${state.zoom.toFixed(2)}, LOD: ${currentLOD}`;
}

function fmtMs(ms: number) {
  return ms ? `${ms.toFixed(1)} ms` : "-";
}

function fmtMB(bytes: number) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function updateStats(force = false) {
  if (!fpsEl) return;
  const now = performance.now();
  if (!force && now - lastStatsUpdate < 250) {
    return;
  }
  lastStatsUpdate = now;

  const parseDur = startup.parseEnd ? startup.parseEnd - startup.fetchStart : 0;
  const rebuildDur = startup.rebuildEnd && startup.rebuildStart ? startup.rebuildEnd - startup.rebuildStart : 0;
  const firstFrameTotal = startup.firstDraw ? startup.firstDraw - startup.fetchStart : 0;
  const afterParse = startup.firstDraw && startup.parseEnd ? startup.firstDraw - startup.parseEnd : 0;

  const lines = [
    `FPS: ${lastFps.toFixed(1)}`,
    `Parse: ${fmtMs(parseDur)}`,
    `Rebuild: ${fmtMs(rebuildDur)}`,
    `FirstFrame total: ${fmtMs(firstFrameTotal)}`,
    `FirstFrame post-parse: ${fmtMs(afterParse)}`,
    `GPU Buffers: ${gpuBuffers.length} (${fmtMB(gpuMemoryBytes)})`
  ];
  fpsEl.innerHTML = lines.join("<br/>");
}

function selectLODForZoom(zoom: number): number {
  // LOD thresholds based on zoom (similar to reference implementation)
  // Higher zoom = more detail needed = lower LOD index
  if (zoom >= 10) return 0;      // Full detail
  if (zoom >= 5) return 1;       // 75% reduced
  if (zoom >= 2) return 2;       // 93% reduced  
  if (zoom >= 0.5) return 3;     // 98% reduced
  return 4;                       // 99% reduced (coarsest)
}

function scheduleDraw() {
  state.needsDraw = true;
}

function render() {
  if (!state.needsDraw) {
    return;
  }
  state.needsDraw = false;
  configureSurface();
  updateUniforms();
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Select LOD based on current zoom
  const lodIndex = selectLODForZoom(state.zoom);
  if (lodIndex !== currentLOD && lodBuffers[lodIndex]) {
    currentLOD = lodIndex;
    vertexBuffer = lodBuffers[lodIndex];
    vertexCount = lodVertexCounts[lodIndex];
  }

  const encoder = device.createCommandEncoder();
  const textureView = context.getCurrentTexture().createView();
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

  const visible = layerOrder.length > 0 && layerVisible.get(layerOrder[layerOrder.length - 1]) !== false;
  if (visible && vertexCount > 0 && vertexBuffer) {
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    // Always bind alpha buffer (contains 1.0 if alphaData not provided)
    const alphaBuf = lodAlphaBuffers[currentLOD];
    if (alphaBuf) {
      pass.setVertexBuffer(1, alphaBuf);
    }
    pass.setBindGroup(0, bindGroup);
    pass.draw(vertexCount);
  }
  pass.end();

  device.queue.submit([encoder.finish()]);

  frameCount += 1;
  const now = performance.now();
  if (now - lastFpsUpdate >= 1000) {
    lastFps = (frameCount * 1000) / (now - lastFpsUpdate);
    frameCount = 0;
    lastFpsUpdate = now;
  }

  if (!startup.firstDraw) {
    startup.firstDraw = now;
  }
}

function loop() {
  render();
  updateCoordOverlay();
  updateStats();
  requestAnimationFrame(loop);
}

async function init() {
  const canvasElement = document.getElementById("viewer");
  if (!(canvasElement instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element #viewer was not found");
  }
  canvas = canvasElement;
  coordOverlayEl = document.getElementById("coordOverlay") as HTMLDivElement | null;
  layersEl = document.getElementById("layers") as HTMLDivElement | null;
  countEl = document.getElementById("count") as HTMLSpanElement | null;
  lastWidthEl = document.getElementById("lastWidth") as HTMLSpanElement | null;
  fpsEl = document.getElementById("fps") as HTMLSpanElement | null;
  debugLogEl = document.getElementById("debugLog") as HTMLDivElement | null;

  interceptConsoleLog(debugLogEl);

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error("WebGPU is not available in this browser");
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Unable to acquire WebGPU adapter");
  }

  device = await adapter.requestDevice();
  wrapCreateBuffer(device);

  const ctx = canvas.getContext("webgpu");
  if (!ctx) {
    throw new Error("Failed to acquire WebGPU context");
  }
  context = ctx;
  canvasFormat = gpu.getPreferredCanvasFormat();

  const shaderModule = device.createShaderModule({ code: basicShaderCode });

  // Create a pipeline using basic.wgsl (always supports per-vertex alpha at location(1)).
  // Vertex buffer layout includes:
  //  - slot 0: vec2<f32> position (location 0)
  //  - slot 1: float32 alpha (location 1) - always bound (1.0 if not provided by Rust)
  pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
        },
        {
          // Per-vertex alpha buffer (1 float per vertex, defaults to 1.0)
          arrayStride: 1 * Float32Array.BYTES_PER_ELEMENT,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }]
        }
      ]
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{
        format: canvasFormat,
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add"
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add"
          }
        }
      }]
    },
    primitive: { topology: "triangle-list" }
  });

  loadColorOverrides();
  refreshLayerLegend();

  uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  const adapterInfoFn = (adapter as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> }).requestAdapterInfo;
  if (adapterInfoFn) {
    try {
      const info = await adapterInfoFn.call(adapter);
      if (info) {
        console.log(`Adapter: ${[info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ")}`);
      }
    } catch (error) {
      console.warn("Unable to query adapter info", error);
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    configureSurface();
    scheduleDraw();
  });
  resizeObserver.observe(canvas);
  window.addEventListener("resize", () => {
    configureSurface();
    scheduleDraw();
  });

  canvas.style.touchAction = "none";

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    state.dragging = true;
    state.dragButton = event.button;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointermove", (event) => {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    haveMouse = true;
    if (!state.dragging) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (state.dragButton === 0 || state.dragButton === 1) {
      state.panX += dx / state.zoom;
      state.panY += dy / state.zoom;
      scheduleDraw();
    }
  });

  const endDrag = (event: PointerEvent) => {
    if (!state.dragging) return;
    state.dragging = false;
    state.dragButton = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.style.cursor = "grab";
  };

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("mouseleave", () => {
    haveMouse = false;
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const pivotWorld = screenToWorld(cssX, cssY);
    const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
    state.zoom = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM);

    const width = Math.max(1, canvas.width);
    const height = Math.max(1, canvas.height);
    const fx = state.flipX ? -1 : 1;
    const scaleX = (2 * state.zoom) / width;
    const scaleY = (2 * state.zoom) / height;
    const xNdc = (2 * cssX) / Math.max(1, canvas.clientWidth) - 1;
    const yNdc = 1 - (2 * cssY) / Math.max(1, canvas.clientHeight);

    state.panX = ((xNdc / fx + 1) / scaleX) - width / 2 - pivotWorld.x;
    state.panY = ((1 - yNdc) / scaleY) - height / 2 - pivotWorld.y;

    scheduleDraw();
  }, { passive: false });

  canvas.addEventListener("mousemove", () => {
    scheduleDraw();
  });

  updateStats(true);
  scheduleDraw();

  // Listen for messages from extension (or test API)
  window.addEventListener("message", (event) => {
    const data = event.data as Record<string, unknown>;
    
    if (data.command === "tessellationData" && data.payload) {
      startup.fetchStart = performance.now();
      const layerJson = data.payload as LayerJSON;
      console.log(`Received tessellation data from extension: ${layerJson.layerId}`);
      loadLayerData(layerJson);
      startup.parseEnd = performance.now();
      applyLayerColor(layerJson.layerId);
      refreshLayerLegend();
      scheduleDraw();
    } else if (data.command === "error") {
      console.error(`Extension error: ${data.message}`);
    }
  });

  // Setup test mode if enabled
  setupTestListeners();

  requestAnimationFrame(loop);
}

init().catch((error) => {
  console.error(error);
  const panel = document.getElementById("ui");
  if (panel) {
    const message = document.createElement("div");
    message.style.marginTop = "8px";
    message.style.color = "#ff6b6b";
    message.textContent = error instanceof Error ? error.message : String(error);
    panel.appendChild(message);
  }
});

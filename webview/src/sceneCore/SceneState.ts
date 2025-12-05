import { ViewerState, LayerColor, LayerInfo, LayerRenderData, ObjectRange, DrcRegion } from "../types";

// Default color palette for layers
const BASE_PALETTE: LayerColor[] = [
  [0.95, 0.95, 0.95, 1], [0.95, 0.2, 0.2, 1], [0.2, 0.8, 0.2, 1],
  [0.3, 0.6, 1.0, 1], [1.0, 0.85, 0.2, 1], [1.0, 0.4, 0.75, 1],
  [0.95, 0.55, 0.2, 1], [0.8, 0.3, 1.0, 1], [0.2, 0.9, 0.9, 1],
  [1.0, 0.6, 0.3, 1], [0.5, 1.0, 0.3, 1], [0.3, 0.4, 0.8, 1],
  [0.9, 0.5, 0.7, 1], [0.7, 0.9, 0.5, 1], [0.5, 0.7, 0.9, 1],
  [0.9, 0.7, 0.4, 1]
];

export interface ScenePipelines {
  noAlpha: GPURenderPipeline;
  withAlpha: GPURenderPipeline;
  instanced: GPURenderPipeline;
  instancedRot: GPURenderPipeline;
}

/** Core scene state and data storage */
export class SceneState {
  public state: ViewerState = {
    panX: 0, panY: 0, zoom: 1,
    flipX: false, flipY: true,
    dragging: false, dragButton: null,
    lastX: 0, lastY: 0, needsDraw: true
  };

  // Layer data
  public layerRenderData = new Map<string, LayerRenderData>();
  public layerInfoMap = new Map<string, LayerInfo>();
  public layerOrder: string[] = [];
  public layerColors = new Map<string, LayerColor>();
  public layerVisible = new Map<string, boolean>();
  public colorOverrides = new Map<string, LayerColor>();
  public viasVisible = true;

  // Move operation state
  public movingObjects: ObjectRange[] = [];
  public globalMoveOffsetX = 0;
  public globalMoveOffsetY = 0;
  
  // Rotation operation state (applied to moving objects)
  public globalRotationOffset = 0; // Radians
  
  // Flip operation state (applied to moving objects)
  public pendingFlipCount = 0; // Odd = flipped, even = not flipped
  
  // Layer pairs for flip operations (TOP layer ↔ BOTTOM layer)
  public layerPairs = new Map<string, string>();

  // DRC overlay state
  public drcRegions: DrcRegion[] = [];
  public drcEnabled = false;
  public drcCurrentIndex = 0;
  public drcVertexBuffer: GPUBuffer | null = null;
  public drcTriangleCount = 0;

  // Highlighted objects for clearing
  public highlightedRanges: ObjectRange[] = [];

  // GPU resources
  public device: GPUDevice | null = null;
  public pipelines: ScenePipelines | null = null;
  public uniformData = new Float32Array(20); // color(4) + m0(4) + m1(4) + m2(4) + moveOffset(4)

  private STORAGE_KEY = "layerColorOverrides";

  constructor() {
    this.loadColorOverrides();
  }

  public setDevice(device: GPUDevice, pipelines: ScenePipelines) {
    this.device = device;
    this.pipelines = pipelines;
  }

  // ==================== Color Management ====================

  public getLayerColor(layerId: string): LayerColor {
    if (!this.layerColors.has(layerId)) {
      const layer = this.layerInfoMap.get(layerId);
      let base: LayerColor = layer 
        ? [...layer.defaultColor] as LayerColor
        : [...BASE_PALETTE[hashStr(layerId) % BASE_PALETTE.length]] as LayerColor;
      
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
    // @ts-ignore
    if (typeof vscode !== 'undefined') {
      // @ts-ignore
      vscode.postMessage({ command: 'SetLayerVisibility', layerId, visible });
    }
  }

  // ==================== Color Storage ====================

  private saveColorOverride(layerId: string, color: LayerColor) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      stored[layerId] = color;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (e) { console.error("Failed to save color override", e); }
  }

  private removeColorOverride(layerId: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      delete stored[layerId];
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
    } catch (e) { console.error("Failed to remove color override", e); }
  }

  private loadColorOverrides() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || "{}");
      for (const [layerId, color] of Object.entries(stored)) {
        if (Array.isArray(color) && color.length === 4) {
          this.colorOverrides.set(layerId, [...color] as LayerColor);
          this.layerColors.set(layerId, [...color] as LayerColor);
        }
      }
    } catch (e) { console.error("Failed to load color overrides", e); }
  }
}

// Utility functions
export function hashStr(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Map obj_type to shader key: 0=Polyline->batch, 1=Polygon->batch_colored, 2=Via->instanced, 3=Pad->instanced_rot */
export function getShaderKey(objType: number): string | null {
  switch (objType) {
    case 0: return 'batch';
    case 1: return 'batch_colored';
    case 2: return 'instanced';
    case 3: return 'instanced_rot';
    default: return null;
  }
}

/** Get render key for layer data lookup */
export function getRenderKey(layerId: string, shaderKey: string): string {
  return shaderKey === 'batch' ? layerId : `${layerId}_${shaderKey}`;
}

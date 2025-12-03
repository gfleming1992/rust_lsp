import { DrcRegion } from "../types";
import { SceneState } from "./SceneState";

/** DRC (Design Rule Check) overlay management */
export class DrcOverlay {
  constructor(private sceneState: SceneState) {}

  // ==================== Public API ====================

  public isDrcEnabled(): boolean {
    return this.sceneState.drcEnabled;
  }

  public setDrcEnabled(enabled: boolean) {
    this.sceneState.drcEnabled = enabled;
    this.sceneState.state.needsDraw = true;
  }

  public getCurrentDrcIndex(): number {
    return this.sceneState.drcCurrentIndex;
  }

  public getDrcRegions(): DrcRegion[] {
    return this.sceneState.drcRegions;
  }

  // ==================== Navigation ====================

  public navigateToNextDrcRegion(): DrcRegion | null {
    if (this.sceneState.drcRegions.length === 0) return null;
    
    this.sceneState.drcCurrentIndex = 
      (this.sceneState.drcCurrentIndex + 1) % this.sceneState.drcRegions.length;
    return this.sceneState.drcRegions[this.sceneState.drcCurrentIndex];
  }

  public navigateToPreviousDrcRegion(): DrcRegion | null {
    if (this.sceneState.drcRegions.length === 0) return null;
    
    this.sceneState.drcCurrentIndex = 
      (this.sceneState.drcCurrentIndex - 1 + this.sceneState.drcRegions.length) % 
      this.sceneState.drcRegions.length;
    return this.sceneState.drcRegions[this.sceneState.drcCurrentIndex];
  }

  public navigateToDrcRegion(index: number): DrcRegion | null {
    if (index < 0 || index >= this.sceneState.drcRegions.length) return null;
    
    this.sceneState.drcCurrentIndex = index;
    return this.sceneState.drcRegions[this.sceneState.drcCurrentIndex];
  }

  // ==================== Loading ====================

  public loadDrcRegions(regions: DrcRegion[]) {
    // Release old buffer
    if (this.sceneState.drcVertexBuffer) {
      this.sceneState.drcVertexBuffer.destroy();
      this.sceneState.drcVertexBuffer = null;
    }
    
    this.sceneState.drcRegions = regions;
    this.sceneState.drcTriangleCount = regions.length * 2; // 2 triangles per region
    this.sceneState.drcCurrentIndex = 0;
    
    if (regions.length === 0 || !this.sceneState.device) {
      console.log('[DRC] No regions to load');
      return;
    }
    
    this.createDrcBuffer(regions);
    console.log(`[DRC] Loaded ${regions.length} violation regions`);
  }

  public clearDrcRegions() {
    if (this.sceneState.drcVertexBuffer) {
      this.sceneState.drcVertexBuffer.destroy();
      this.sceneState.drcVertexBuffer = null;
    }
    
    this.sceneState.drcRegions = [];
    this.sceneState.drcTriangleCount = 0;
    this.sceneState.drcCurrentIndex = 0;
    this.sceneState.drcEnabled = false;
    this.sceneState.state.needsDraw = true;
    
    console.log('[DRC] Cleared all violation regions');
  }

  // ==================== Rendering Support ====================

  public getDrcBuffer(): GPUBuffer | null {
    return this.sceneState.drcVertexBuffer;
  }

  public getDrcTriangleCount(): number {
    return this.sceneState.drcTriangleCount;
  }

  // ==================== Private Helpers ====================

  private createDrcBuffer(regions: DrcRegion[]) {
    const device = this.sceneState.device;
    if (!device) return;
    
    // Each region: 6 vertices (2 triangles) × 2 floats (x, y) = 12 floats
    const vertexData = new Float32Array(regions.length * 12);
    
    let offset = 0;
    for (const region of regions) {
      const [minX, minY, maxX, maxY] = region.bounds;
      
      // Triangle 1: bottom-left, bottom-right, top-right
      vertexData[offset++] = minX; vertexData[offset++] = minY;
      vertexData[offset++] = maxX; vertexData[offset++] = minY;
      vertexData[offset++] = maxX; vertexData[offset++] = maxY;
      
      // Triangle 2: bottom-left, top-right, top-left
      vertexData[offset++] = minX; vertexData[offset++] = minY;
      vertexData[offset++] = maxX; vertexData[offset++] = maxY;
      vertexData[offset++] = minX; vertexData[offset++] = maxY;
    }
    
    this.sceneState.drcVertexBuffer = device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    
    new Float32Array(this.sceneState.drcVertexBuffer.getMappedRange()).set(vertexData);
    this.sceneState.drcVertexBuffer.unmap();
  }
}

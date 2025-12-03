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
    this.updateDrcBufferForRegion(this.sceneState.drcCurrentIndex);
    this.sceneState.drcEnabled = true;
    this.sceneState.state.needsDraw = true;
    return this.sceneState.drcRegions[this.sceneState.drcCurrentIndex];
  }

  public navigateToPreviousDrcRegion(): DrcRegion | null {
    if (this.sceneState.drcRegions.length === 0) return null;
    
    this.sceneState.drcCurrentIndex = 
      (this.sceneState.drcCurrentIndex - 1 + this.sceneState.drcRegions.length) % 
      this.sceneState.drcRegions.length;
    this.updateDrcBufferForRegion(this.sceneState.drcCurrentIndex);
    this.sceneState.drcEnabled = true;
    this.sceneState.state.needsDraw = true;
    return this.sceneState.drcRegions[this.sceneState.drcCurrentIndex];
  }

  public navigateToDrcRegion(index: number): DrcRegion | null {
    if (index < 0 || index >= this.sceneState.drcRegions.length) return null;
    
    this.sceneState.drcCurrentIndex = index;
    this.updateDrcBufferForRegion(index);
    this.sceneState.drcEnabled = true;
    this.sceneState.state.needsDraw = true;
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
    this.sceneState.drcCurrentIndex = 0;
    
    if (regions.length === 0 || !this.sceneState.device) {
      console.log('[DRC] No regions to load');
      this.sceneState.drcEnabled = false;
      return;
    }
    
    console.log(`[DRC] Loading ${regions.length} DRC regions`);
    this.updateDrcBufferForRegion(0);
    this.sceneState.drcEnabled = true;
    this.sceneState.state.needsDraw = true;
  }

  /** Update GPU buffer for a specific DRC region's triangles */
  private updateDrcBufferForRegion(index: number) {
    const device = this.sceneState.device;
    if (!device || index < 0 || index >= this.sceneState.drcRegions.length) {
      this.sceneState.drcTriangleCount = 0;
      return;
    }
    
    const region = this.sceneState.drcRegions[index];
    const vertices = new Float32Array(region.triangle_vertices);
    
    if (this.sceneState.drcVertexBuffer) {
      this.sceneState.drcVertexBuffer.destroy();
    }
    
    this.sceneState.drcVertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    
    new Float32Array(this.sceneState.drcVertexBuffer.getMappedRange()).set(vertices);
    this.sceneState.drcVertexBuffer.unmap();
    this.sceneState.drcTriangleCount = region.triangle_count;
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
}

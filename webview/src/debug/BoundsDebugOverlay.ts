import { Scene } from "../Scene";
import { Renderer } from "../Renderer";
import { ObjectRange } from "../types";

/**
 * Debug overlay for visualizing bounds discrepancies between TypeScript and Rust/LSP.
 * 
 * Renders two types of rectangles:
 * - **TypeScript bounds (blue)**: What the WebView thinks the bounds are after transforms
 * - **Rust/LSP bounds (red)**: What the LSP returns as actual bounds
 * 
 * This helps debug position mismatches after flip/rotate/move operations.
 */
export class BoundsDebugOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: Scene;
  private renderer: Renderer;
  
  // TypeScript-side bounds (what WebView thinks)
  private tsBounds: Map<number, { bounds: [number, number, number, number]; label: string }> = new Map();
  
  // Rust/LSP-side bounds (what LSP returns)
  private rustBounds: Map<number, { bounds: [number, number, number, number]; label: string }> = new Map();
  
  // Visibility flags
  private tsEnabled = false;
  private rustEnabled = false;
  
  // Colors
  private static readonly TS_COLOR = 'rgba(0, 100, 255, 0.8)';       // Blue
  private static readonly TS_FILL = 'rgba(0, 100, 255, 0.15)';
  private static readonly RUST_COLOR = 'rgba(255, 50, 50, 0.8)';     // Red
  private static readonly RUST_FILL = 'rgba(255, 50, 50, 0.15)';
  
  constructor(gpuCanvas: HTMLCanvasElement, scene: Scene, renderer: Renderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    // Create overlay canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 11;
    `;
    
    // Insert after GPU canvas
    gpuCanvas.parentElement?.appendChild(this.canvas);
    
    this.ctx = this.canvas.getContext('2d')!;
    
    // Match canvas size
    this.resize(gpuCanvas.width, gpuCanvas.height);
    
    // Listen for resize
    const resizeObserver = new ResizeObserver(() => {
      this.resize(gpuCanvas.width, gpuCanvas.height);
    });
    resizeObserver.observe(gpuCanvas);
    
    console.log('[BoundsDebugOverlay] Initialized - Use checkboxes to toggle TS/Rust bounds overlays');
  }
  
  public resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
  }
  
  // ========== Visibility Controls ==========
  
  public setTsVisible(visible: boolean) {
    this.tsEnabled = visible;
    if (!this.isAnyEnabled()) {
      this.clear();
    }
    console.log(`[BoundsDebugOverlay] TypeScript bounds: ${this.tsEnabled ? 'ON' : 'OFF'}`);
  }
  
  public setRustVisible(visible: boolean) {
    this.rustEnabled = visible;
    if (!this.isAnyEnabled()) {
      this.clear();
    }
    console.log(`[BoundsDebugOverlay] Rust/LSP bounds: ${this.rustEnabled ? 'ON' : 'OFF'}`);
  }
  
  public isTsEnabled(): boolean {
    return this.tsEnabled;
  }
  
  public isRustEnabled(): boolean {
    return this.rustEnabled;
  }
  
  public isAnyEnabled(): boolean {
    return this.tsEnabled || this.rustEnabled;
  }
  
  // ========== Data Management ==========
  
  /**
   * Set TypeScript-calculated bounds for selected objects.
   * Call this after applying transforms in WebView to record what TS thinks the bounds are.
   */
  public setTsBounds(objects: ObjectRange[]) {
    this.tsBounds.clear();
    for (const obj of objects) {
      const label = obj.pin_ref || obj.component_ref || `id:${obj.id}`;
      this.tsBounds.set(obj.id, {
        bounds: [...obj.bounds] as [number, number, number, number],
        label: `TS: ${label}`
      });
    }
    console.log(`[BoundsDebugOverlay] Set ${this.tsBounds.size} TypeScript bounds`);
  }
  
  /**
   * Set Rust/LSP-returned bounds for selected objects.
   * Call this after receiving Select response from LSP to see what LSP thinks.
   */
  public setRustBounds(objects: ObjectRange[]) {
    this.rustBounds.clear();
    for (const obj of objects) {
      const label = obj.pin_ref || obj.component_ref || `id:${obj.id}`;
      this.rustBounds.set(obj.id, {
        bounds: [...obj.bounds] as [number, number, number, number],
        label: `RUST: ${label}`
      });
    }
    console.log(`[BoundsDebugOverlay] Set ${this.rustBounds.size} Rust/LSP bounds`);
  }
  
  /**
   * Update just the TypeScript bounds for specific object IDs.
   * Useful after transform operations.
   */
  public updateTsBoundsForObjects(objects: ObjectRange[]) {
    for (const obj of objects) {
      const label = obj.pin_ref || obj.component_ref || `id:${obj.id}`;
      this.tsBounds.set(obj.id, {
        bounds: [...obj.bounds] as [number, number, number, number],
        label: `TS: ${label}`
      });
    }
    console.log(`[BoundsDebugOverlay] Updated ${objects.length} TypeScript bounds`);
  }
  
  /**
   * Clear all bounds data
   */
  public clearBounds() {
    this.tsBounds.clear();
    this.rustBounds.clear();
    this.clear();
  }
  
  public clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  // ========== Coordinate Conversion ==========
  
  private worldToScreen(worldX: number, worldY: number): [number, number] {
    const result = this.renderer.worldToScreen(worldX, worldY);
    return [result.x, result.y];
  }
  
  // ========== Rendering ==========
  
  /**
   * Render the debug overlays
   * Call after GPU render
   */
  public render() {
    // Always draw status even if disabled, so user knows it's working
    this.clear();
    
    const { zoom } = this.scene.state;
    
    // Show status at bottom of screen
    this.ctx.font = '11px monospace';
    this.ctx.fillStyle = '#fff';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText(
      `[BoundsOverlay] TS=${this.tsEnabled ? 'ON' : 'off'}(${this.tsBounds.size}) Rust=${this.rustEnabled ? 'ON' : 'off'}(${this.rustBounds.size}) zoom=${zoom.toFixed(1)}`,
      10, this.canvas.height - 10
    );
    
    if (!this.isAnyEnabled()) return;
    
    // Draw legend
    this.drawLegend();
    
    // Render TypeScript bounds (blue)
    if (this.tsEnabled) {
      console.log(`[BoundsDebugOverlay] Rendering ${this.tsBounds.size} TS bounds`);
      this.renderBoundsSet(this.tsBounds, BoundsDebugOverlay.TS_COLOR, BoundsDebugOverlay.TS_FILL, 'TS');
    }
    
    // Render Rust bounds (red) - draw second so they appear on top
    if (this.rustEnabled) {
      console.log(`[BoundsDebugOverlay] Rendering ${this.rustBounds.size} Rust bounds`);
      this.renderBoundsSet(this.rustBounds, BoundsDebugOverlay.RUST_COLOR, BoundsDebugOverlay.RUST_FILL, 'RUST');
    }
  }
  
  private renderBoundsSet(
    boundsMap: Map<number, { bounds: [number, number, number, number]; label: string }>,
    strokeColor: string,
    fillColor: string,
    prefix: string
  ) {
    this.ctx.strokeStyle = strokeColor;
    this.ctx.fillStyle = fillColor;
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash(prefix === 'RUST' ? [4, 4] : []); // Dashed for Rust
    
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    
    for (const [id, data] of boundsMap) {
      const [minX, minY, maxX, maxY] = data.bounds;
      
      // Convert world bounds to screen
      const [sx1, sy1] = this.worldToScreen(minX, maxY); // top-left (maxY is up in world)
      const [sx2, sy2] = this.worldToScreen(maxX, minY); // bottom-right
      
      // Screen-space culling
      if (sx2 < 0 || sx1 > w || sy2 < 0 || sy1 > h) continue;
      
      const rectW = sx2 - sx1;
      const rectH = sy2 - sy1;
      
      // Draw filled rect
      this.ctx.fillRect(sx1, sy1, rectW, rectH);
      
      // Draw border
      this.ctx.strokeRect(sx1, sy1, rectW, rectH);
      
      // Draw center marker
      const cx = (sx1 + sx2) / 2;
      const cy = (sy1 + sy2) / 2;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      this.ctx.fillStyle = strokeColor;
      this.ctx.fill();
      this.ctx.fillStyle = fillColor; // Reset
      
      // Draw label at center
      this.ctx.font = '10px monospace';
      this.ctx.fillStyle = strokeColor;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'top';
      
      // Label with bounds info
      const boundsLabel = `[${minX.toFixed(1)}, ${minY.toFixed(1)}, ${maxX.toFixed(1)}, ${maxY.toFixed(1)}]`;
      this.ctx.fillText(data.label, cx, sy1 - 24);
      this.ctx.fillText(boundsLabel, cx, sy1 - 12);
      this.ctx.fillStyle = fillColor; // Reset
    }
    
    this.ctx.setLineDash([]); // Reset
  }
  
  private drawLegend() {
    const x = 10;
    let y = 40;
    
    this.ctx.font = 'bold 12px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Bounds Debug Overlay', x, y);
    y += 16;
    
    if (this.tsEnabled) {
      this.ctx.fillStyle = BoundsDebugOverlay.TS_COLOR;
      this.ctx.fillRect(x, y + 2, 20, 10);
      this.ctx.fillStyle = '#fff';
      this.ctx.fillText('TypeScript (solid)', x + 25, y);
      y += 14;
    }
    
    if (this.rustEnabled) {
      this.ctx.strokeStyle = BoundsDebugOverlay.RUST_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([3, 3]);
      this.ctx.strokeRect(x, y + 2, 20, 10);
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = '#fff';
      this.ctx.fillText('Rust/LSP (dashed)', x + 25, y);
      y += 14;
    }
  }
  
  /**
   * Calculate and log the discrepancy between TS and Rust bounds for each object.
   * Useful for debugging.
   */
  public logDiscrepancies() {
    console.log('[BoundsDebugOverlay] === BOUNDS DISCREPANCY REPORT ===');
    
    for (const [id, tsData] of this.tsBounds) {
      const rustData = this.rustBounds.get(id);
      if (!rustData) {
        console.log(`  [${id}] ${tsData.label}: No Rust bounds available`);
        continue;
      }
      
      const [tsMinX, tsMinY, tsMaxX, tsMaxY] = tsData.bounds;
      const [rMinX, rMinY, rMaxX, rMaxY] = rustData.bounds;
      
      const dxMin = tsMinX - rMinX;
      const dyMin = tsMinY - rMinY;
      const dxMax = tsMaxX - rMaxX;
      const dyMax = tsMaxY - rMaxY;
      
      const tsCenterX = (tsMinX + tsMaxX) / 2;
      const tsCenterY = (tsMinY + tsMaxY) / 2;
      const rCenterX = (rMinX + rMaxX) / 2;
      const rCenterY = (rMinY + rMaxY) / 2;
      const centerDist = Math.sqrt((tsCenterX - rCenterX) ** 2 + (tsCenterY - rCenterY) ** 2);
      
      if (Math.abs(dxMin) > 0.01 || Math.abs(dyMin) > 0.01 || Math.abs(dxMax) > 0.01 || Math.abs(dyMax) > 0.01) {
        console.log(`  [${id}] ${tsData.label}:`);
        console.log(`    TS:   [${tsMinX.toFixed(3)}, ${tsMinY.toFixed(3)}, ${tsMaxX.toFixed(3)}, ${tsMaxY.toFixed(3)}]`);
        console.log(`    RUST: [${rMinX.toFixed(3)}, ${rMinY.toFixed(3)}, ${rMaxX.toFixed(3)}, ${rMaxY.toFixed(3)}]`);
        console.log(`    Δ: [${dxMin.toFixed(3)}, ${dyMin.toFixed(3)}, ${dxMax.toFixed(3)}, ${dyMax.toFixed(3)}]  center dist: ${centerDist.toFixed(3)}`);
      } else {
        console.log(`  [${id}] ${tsData.label}: MATCH ✓`);
      }
    }
    
    console.log('[BoundsDebugOverlay] === END REPORT ===');
  }
}

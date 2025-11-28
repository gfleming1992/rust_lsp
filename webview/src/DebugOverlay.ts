import { Scene } from "./Scene";
import { Renderer } from "./Renderer";

// DEBUG: Set to true to enable the debug overlay on startup
// Set to false to have it default to off (checkbox still works)
export const DEBUG_SHOW_COORDS = false;

interface DebugPoint {
  worldX: number;
  worldY: number;
  label: string;
  color: string;
}

export class DebugOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: Scene;
  private renderer: Renderer;
  private debugPoints: DebugPoint[] = [];
  private enabled = false; // Default to OFF
  
  // Limit points to avoid overwhelming the display
  private maxPoints = 5000;
  
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
      z-index: 10;
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
    
    // Keyboard shortcut removed - use the checkbox in UI instead
    // (Ctrl+D conflicts with delete shortcut)
    
    console.log('[DebugOverlay] Initialized - Use checkbox to toggle coordinate labels');
  }
  
  public resize(width: number, height: number) {
    // Match the GPU canvas dimensions exactly
    this.canvas.width = width;
    this.canvas.height = height;
  }
  
  public toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.clear();
    }
    console.log(`[DebugOverlay] ${this.enabled ? 'Enabled' : 'Disabled'}`);
  }
  
  public setVisible(visible: boolean) {
    this.enabled = visible;
    if (!this.enabled) {
      this.clear();
    }
    console.log(`[DebugOverlay] ${this.enabled ? 'Enabled' : 'Disabled'}`);
  }
  
  public isEnabled(): boolean {
    return this.enabled;
  }
  
  public clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  /**
   * Extract debug points from layer geometry
   * Call this when layers are loaded
   */
  public extractPointsFromLayers() {
    this.debugPoints = [];
    
    let pointCount = 0;
    
    for (const [renderKey, renderData] of this.scene.layerRenderData) {
      const layerId = renderData.layerId;
      
      // Skip hidden layers
      if (!this.scene.layerVisible.get(layerId)) continue;
      
      const color = this.scene.getLayerColor(layerId);
      const colorStr = `rgba(${Math.round(color[0]*255)}, ${Math.round(color[1]*255)}, ${Math.round(color[2]*255)}, 1)`;
      
      // Extract from cpuInstanceBuffers (these contain pad/via positions)
      // For instanced geometry, LODs are organized as: [shape0_lod0, shape1_lod0, ..., shape0_lod1, shape1_lod1, ...]
      // Number of shapes = totalLODs / 3
      if (renderData.cpuInstanceBuffers && renderData.cpuInstanceBuffers.length > 0) {
        const totalLODs = renderData.cpuInstanceBuffers.length;
        const numShapes = Math.floor(totalLODs / 3);
        
        // Iterate through all LOD0 entries (first numShapes entries)
        for (let shapeIdx = 0; shapeIdx < numShapes && pointCount < this.maxPoints; shapeIdx++) {
          const lodData = renderData.cpuInstanceBuffers[shapeIdx];
          if (!lodData) continue;
          
          // For instanced_rot: 3 floats per instance (x, y, packed_rot_vis)
          // For instanced: 3 floats per instance (x, y, packed_vis)
          const floatsPerInstance = 3;
          const prefix = renderData.shaderType === 'instanced' ? 'V:' : '';
          
          for (let i = 0; i < lodData.length && pointCount < this.maxPoints; i += floatsPerInstance) {
            const x = lodData[i];
            const y = lodData[i + 1];
            this.debugPoints.push({
              worldX: x,
              worldY: y,
              label: `${prefix}${x.toFixed(2)},${y.toFixed(2)}`,
              color: renderData.shaderType === 'instanced' ? '#00ffff' : colorStr
            });
            pointCount++;
          }
        }
      }
    }
    
    console.log(`[DebugOverlay] Extracted ${this.debugPoints.length} debug points from ${this.scene.layerRenderData.size} render entries`);
  }
  
  /**
   * Convert world coordinates to screen coordinates
   * Use the Renderer's worldToScreen for consistency
   */
  private worldToScreen(worldX: number, worldY: number): [number, number] {
    const result = this.renderer.worldToScreen(worldX, worldY);
    return [result.x, result.y];
  }
  
  /**
   * Render debug labels
   * Call this after GPU render, passing current view bounds
   */
  public render() {
    if (!this.enabled) return;
    
    this.clear();
    
    const { zoom } = this.scene.state;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    
    // Only show labels when zoomed in enough
    if (zoom < 5) {
      // Show hint
      this.ctx.font = '12px monospace';
      this.ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
      this.ctx.fillText('Zoom in more to see coordinate labels', 10, 20);
      return;
    }
    
    // Adjust font size based on zoom
    const fontSize = Math.max(8, Math.min(14, zoom * 0.8));
    this.ctx.font = `${fontSize}px monospace`;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'bottom';
    
    let rendered = 0;
    const maxRender = 500; // Don't render too many at once
    
    for (const pt of this.debugPoints) {
      if (rendered >= maxRender) break;
      
      const [sx, sy] = this.worldToScreen(pt.worldX, pt.worldY);
      
      // Screen-space culling - skip if off screen
      if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;
      
      // Draw tooltip-style background
      const textWidth = this.ctx.measureText(pt.label).width;
      const padding = 4;
      const boxHeight = fontSize + padding * 2;
      const boxWidth = textWidth + padding * 2;
      
      // Dark background with border (like tooltip)
      this.ctx.fillStyle = 'rgba(30, 30, 30, 0.9)';
      this.ctx.strokeStyle = 'rgba(100, 100, 100, 0.8)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.roundRect(sx + 5, sy - boxHeight - 2, boxWidth, boxHeight, 3);
      this.ctx.fill();
      this.ctx.stroke();
      
      // Draw label text
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillText(pt.label, sx + 5 + padding, sy - padding - 2);
      
      // Draw small colored dot at exact position
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      this.ctx.fillStyle = pt.color;
      this.ctx.fill();
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
      
      rendered++;
    }
    
    // Show count
    this.ctx.font = '12px monospace';
    this.ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
    this.ctx.fillText(`Debug: ${rendered}/${this.debugPoints.length} pts | zoom=${zoom.toFixed(1)} | canvas=${w}x${h}`, 10, 20);
    
    // Debug: log first point transform
    if (this.debugPoints.length > 0 && rendered === 0) {
      const pt = this.debugPoints[0];
      const [sx, sy] = this.worldToScreen(pt.worldX, pt.worldY);
      console.log(`[DebugOverlay] First point: world(${pt.worldX.toFixed(2)}, ${pt.worldY.toFixed(2)}) -> screen(${sx.toFixed(0)}, ${sy.toFixed(0)}), canvas ${w}x${h}`);
    }
  }
}

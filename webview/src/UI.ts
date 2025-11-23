import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { LayerColor } from "./types";

export class UI {
  private scene: Scene;
  private renderer: Renderer;
  
  private layersEl: HTMLDivElement | null = null;
  private coordOverlayEl: HTMLDivElement | null = null;
  private fpsEl: HTMLSpanElement | null = null;
  private debugLogEl: HTMLDivElement | null = null;
  
  private lastStatsUpdate = 0;

  constructor(scene: Scene, renderer: Renderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    this.layersEl = document.getElementById("layers") as HTMLDivElement | null;
    this.coordOverlayEl = document.getElementById("coordOverlay") as HTMLDivElement | null;
    this.fpsEl = document.getElementById("fps") as HTMLSpanElement | null;
    this.debugLogEl = document.getElementById("debugLog") as HTMLDivElement | null;
    
    this.interceptConsoleLog(this.debugLogEl);
  }

  private interceptConsoleLog(target: HTMLDivElement | null) {
    if (!target) {
      return;
    }
    console.log("[LOGGING] Browser DevTools console is the primary log output");
  }

  public refreshLayerLegend() {
    if (!this.layersEl) {
      return;
    }
    const legendParts: string[] = [];
    legendParts.push(`
      <div style="margin-bottom:4px; display:flex; gap:4px; flex-wrap:wrap; font:11px sans-serif;">
        <button type="button" data-layer-action="all" style="padding:2px 6px;">All</button>
        <button type="button" data-layer-action="none" style="padding:2px 6px;">None</button>
        <button type="button" data-layer-action="invert" style="padding:2px 6px;">Invert</button>
        <button type="button" id="savePcbBtn" style="padding:2px 6px; background:#4a9eff; color:#fff; border:1px solid #3a8eef; border-radius:3px; font-weight:bold;">💾 Save</button>
      </div>
    `);

    const entries = this.scene.layerOrder.map((layerId) => [layerId, this.scene.getLayerColor(layerId)] as const);

    legendParts.push(`<div>`);
    for (const [layerId, color] of entries) {
      const visible = this.scene.layerVisible.get(layerId) !== false;
      legendParts.push(this.createLegendRow(layerId, color, visible));
    }
    legendParts.push(`</div>`);

    this.layersEl.innerHTML = legendParts.join("");

    this.layersEl.querySelectorAll("button[data-layer-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const action = (event.currentTarget as HTMLButtonElement).dataset.layerAction;
        if (action === "all") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, true);
          }
        } else if (action === "none") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, false);
          }
        } else if (action === "invert") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.layerVisible.set(layerId, !(this.scene.layerVisible.get(layerId) !== false));
          }
        }
        this.refreshLayerLegend();
        this.scene.state.needsDraw = true;
      });
    });

    this.layersEl.querySelectorAll("input[data-layer-toggle]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const target = event.currentTarget as HTMLInputElement;
        const layerId = target.dataset.layerToggle;
        if (!layerId) return;
        this.scene.toggleLayerVisibility(layerId, target.checked);
      });
    });

    this.layersEl.querySelectorAll<HTMLButtonElement>("button[data-layer-color]").forEach((button) => {
      button.addEventListener("click", () => {
        const layerId = button.dataset.layerColor;
        if (!layerId) return;
        const current = this.scene.getLayerColor(layerId);
        this.showColorPicker(layerId, current);
      });
    });

    // Add save button handler
    const saveBtn = document.getElementById("savePcbBtn");
    saveBtn?.addEventListener("click", () => {
      this.handleSave();
    });
  }

  private async handleSave() {
    // Check if running in VS Code webview
    const vscode = (window as any).vscode;
    if (!vscode) {
      console.warn("[SAVE] Save is only available in VS Code extension mode");
      alert("Save is only available when running in VS Code.\n\nTo use save:\n1. Press F5 in VS Code to launch Extension Development Host\n2. Open a PCB file\n3. Click the Save button");
      
      const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 Save";
      }
      return;
    }
    
    console.log("[SAVE] Requesting save...");
    const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "💾 Saving...";
    }
    
    // Send save request - response will come via window message event
    vscode.postMessage({ command: 'Save' });
  }

  private createLegendRow(layerId: string, color: LayerColor, visible: boolean): string {
    const rgb = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, 1)`;
    const layer = this.scene.layerInfoMap.get(layerId);
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

  private showColorPicker(layerId: string, currentColor: LayerColor) {
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
        this.scene.setLayerColor(layerId, color);
        this.notifyColorChange(layerId, color);
        this.refreshLayerLegend();
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
        this.scene.setLayerColor(layerId, color);
        this.notifyColorChange(layerId, color);
        this.refreshLayerLegend();
        modal.remove();
      }
    });

    const resetButton = document.getElementById("resetColorBtn");
    resetButton?.addEventListener("click", () => {
      this.scene.resetLayerColor(layerId);
      this.refreshLayerLegend();
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

  public updateCoordOverlay(mouseX: number, mouseY: number, haveMouse: boolean) {
    if (!this.coordOverlayEl) return;
    const verts = this.renderer.lastVertexCount > 0 ? `${(this.renderer.lastVertexCount / 1000).toFixed(1)}K` : '-';
    const tris = this.renderer.lastIndexCount > 0 ? `${(this.renderer.lastIndexCount / 3000).toFixed(1)}K` : '-';
    
    if (!haveMouse) {
      this.coordOverlayEl.textContent = `x: -, y: -, zoom: ${this.scene.state.zoom.toFixed(2)}, verts: ${verts}, tris: ${tris}`;
      return;
    }
    
    const rect = this.renderer.canvas.getBoundingClientRect();
    const world = this.renderer.screenToWorld(mouseX - rect.left, mouseY - rect.top);
    this.coordOverlayEl.textContent = `x: ${world.x.toFixed(2)}, y: ${world.y.toFixed(2)}, zoom: ${this.scene.state.zoom.toFixed(2)}, verts: ${verts}, tris: ${tris}`;
  }

  public updateStats(force = false) {
    if (!this.fpsEl) return;
    const now = performance.now();
    if (!force && now - this.lastStatsUpdate < 250) {
      return;
    }
    this.lastStatsUpdate = now;

    const lines = [
      `FPS: ${this.renderer.lastFps.toFixed(1)}`,
      `GPU Buffers: ${this.renderer.gpuBuffers.length} (${(this.renderer.gpuMemoryBytes / 1048576).toFixed(2)} MB)`
    ];

    // Add JS memory stats if available (Chrome/Edge only)
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
    if (perf.memory) {
      const usedMB = (perf.memory.usedJSHeapSize / 1048576).toFixed(2);
      const totalMB = (perf.memory.totalJSHeapSize / 1048576).toFixed(2);
      lines.push(`JS Heap: ${usedMB} / ${totalMB} MB`);
    }

    this.fpsEl.innerHTML = lines.join("<br/>");
  }

  private notifyColorChange(layerId: string, color: LayerColor) {
    const vscode = (window as any).vscode;
    if (!vscode) {
      return; // Dev server mode - no persistence
    }
    
    console.log(`[COLOR] Notifying extension of color change for ${layerId}:`, color);
    vscode.postMessage({ 
      command: 'UpdateLayerColor', 
      layerId: layerId,
      color: color
    });
  }
}

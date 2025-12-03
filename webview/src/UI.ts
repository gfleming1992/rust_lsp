import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { LayerColor, DrcRegion } from "./types";
import { DebugOverlay } from "./DebugOverlay";
import { DrcPanel } from "./ui/DrcPanel";
import { showColorPicker } from "./ui/ColorPicker";
import { setupResizeHandle } from "./ui/resizeHandle";

export class UI {
  private scene: Scene;
  private renderer: Renderer;
  private debugOverlay: DebugOverlay | null = null;
  
  private layersEl: HTMLDivElement | null = null;
  private coordOverlayEl: HTMLDivElement | null = null;
  private fpsEl: HTMLSpanElement | null = null;
  private debugLogEl: HTMLDivElement | null = null;
  
  private lastStatsUpdate = 0;
  private rustMemoryBytes: number | null = null;

  private highlightBox: HTMLDivElement;
  private contextMenu: HTMLDivElement;
  private currentHighlightBounds: [number, number, number, number] | null = null;
  private onDelete: (() => void) | null = null;

  // DRC Panel component
  private drcPanelComponent: DrcPanel | null = null;

  constructor(scene: Scene, renderer: Renderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    this.layersEl = document.getElementById("layers") as HTMLDivElement | null;
    this.coordOverlayEl = document.getElementById("coordOverlay") as HTMLDivElement | null;
    this.fpsEl = document.getElementById("fps") as HTMLSpanElement | null;
    this.debugLogEl = document.getElementById("debugLog") as HTMLDivElement | null;
    
    // Add debug coordinates checkbox
    this.addDebugCoordsCheckbox();
    
    this.highlightBox = document.createElement('div');
    this.highlightBox.style.position = 'absolute';
    this.highlightBox.style.pointerEvents = 'none';
    this.highlightBox.style.display = 'none';
    this.highlightBox.style.zIndex = '999';
    // Note: Visual highlighting is now done in Scene via shader
    // This box is kept for context menu bounds tracking only
    
    this.contextMenu = document.createElement('div');
    this.contextMenu.style.position = 'fixed';
    this.contextMenu.style.background = '#252526';
    this.contextMenu.style.border = '1px solid #454545';
    this.contextMenu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
    this.contextMenu.style.padding = '4px 0';
    this.contextMenu.style.display = 'none';
    this.contextMenu.style.zIndex = '10000';
    this.contextMenu.style.minWidth = '120px';
    this.contextMenu.style.borderRadius = '4px';
    
    const deleteOption = document.createElement('div');
    deleteOption.textContent = 'Delete';
    deleteOption.style.padding = '6px 12px';
    deleteOption.style.cursor = 'pointer';
    deleteOption.style.color = '#cccccc';
    deleteOption.style.fontSize = '13px';
    deleteOption.style.fontFamily = 'Segoe UI, sans-serif';
    
    deleteOption.addEventListener('mouseenter', () => {
        deleteOption.style.backgroundColor = '#094771';
        deleteOption.style.color = '#ffffff';
    });
    deleteOption.addEventListener('mouseleave', () => {
        deleteOption.style.backgroundColor = 'transparent';
        deleteOption.style.color = '#cccccc';
    });
    deleteOption.addEventListener('click', () => {
        if (this.onDelete) {
            this.onDelete();
        }
        this.contextMenu.style.display = 'none';
    });
    
    this.contextMenu.appendChild(deleteOption);
    document.body.appendChild(this.contextMenu);

    // Append to canvas parent if possible, or body
    if (this.renderer.canvas.parentElement) {
        this.renderer.canvas.parentElement.style.position = 'relative'; // Ensure parent is relative
        this.renderer.canvas.parentElement.appendChild(this.highlightBox);
    } else {
        document.body.appendChild(this.highlightBox);
    }

    // Context menu listener
    document.addEventListener('contextmenu', (e) => {
        if (this.currentHighlightBounds) {
            e.preventDefault();
            console.log('[UI] Opening context menu at', e.clientX, e.clientY);
            this.contextMenu.style.display = 'block';
            this.contextMenu.style.left = `${e.clientX}px`;
            this.contextMenu.style.top = `${e.clientY}px`;
        } else {
            console.log('[UI] Context menu ignored - no selection');
        }
    });

    // Close context menu on click elsewhere
    document.addEventListener('click', (e) => {
        if (this.contextMenu.style.display === 'block' && !this.contextMenu.contains(e.target as Node)) {
            this.contextMenu.style.display = 'none';
        }
    });

    this.interceptConsoleLog(this.debugLogEl);
    this.setupStatsToggle();
    this.createDrcPanel();
    this.setupResizeHandles();
  }

  private setupStatsToggle() {
    const statsHeader = document.getElementById('stats-header');
    const statsContent = document.getElementById('stats-content');
    if (!statsHeader || !statsContent) return;

    statsHeader.addEventListener('click', () => {
      const isExpanded = statsContent.classList.contains('expanded');
      statsContent.classList.toggle('expanded');
      statsHeader.querySelector('.collapse-icon')!.textContent = isExpanded ? '▶' : '▼';
    });
  }

  private setupResizeHandles() {
    // Layer list vertical resize
    setupResizeHandle(
      'layer-resize-handle',
      () => this.layersEl?.querySelector('div[style*="overflow-y"]') as HTMLElement | null,
      'y', 100, 800
    );
    
    // DRC list vertical resize
    setupResizeHandle(
      'drc-resize-handle',
      () => document.getElementById('drcListContainer'),
      'y', 100, 600
    );
    
    // Panel width horizontal resize
    setupResizeHandle(
      'panel-width-handle',
      () => document.getElementById('ui-top-left-content'),
      'x', 180, 500, 'width'
    );
  }

  public setOnDelete(callback: () => void) {
    this.onDelete = callback;
  }

  public highlightObject(bounds: [number, number, number, number]) {
    this.currentHighlightBounds = bounds;
    this.updateHighlightPosition();
  }

  public updateHighlightPosition() {
    if (!this.currentHighlightBounds) return;
    
    const [minX, minY, maxX, maxY] = this.currentHighlightBounds;
    
    const p1 = this.renderer.worldToScreen(minX, minY);
    const p2 = this.renderer.worldToScreen(maxX, maxY);
    
    const left = Math.min(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const width = Math.abs(p2.x - p1.x);
    const height = Math.abs(p2.y - p1.y);
    
    this.highlightBox.style.display = 'block';
    this.highlightBox.style.left = `${left}px`;
    this.highlightBox.style.top = `${top}px`;
    this.highlightBox.style.width = `${width}px`;
    this.highlightBox.style.height = `${height}px`;
  }

  public clearHighlight() {
    this.currentHighlightBounds = null;
    this.highlightBox.style.display = 'none';
  }


  private createDrcPanel() {
    if (!this.layersEl) return;
    
    // Use the DrcPanel component
    this.drcPanelComponent = new DrcPanel(this.layersEl);
    this.drcPanelComponent.create();
  }

  public showDrcProgress() {
    this.drcPanelComponent?.showProgress();
  }

  public hideDrcProgress() {
    this.drcPanelComponent?.hideProgress();
  }

  public populateDrcList(regions: DrcRegion[]) {
    this.drcPanelComponent?.populateList(regions);
  }

  /** Clear DRC highlight - deselect list item and hide detail panel */
  public clearDrcHighlight() {
    this.drcPanelComponent?.clearHighlight();
  }

  public setOnRunDrc(callback: () => void) {
    this.drcPanelComponent?.setOnRunDrc(callback);
  }

  public setOnDrcNavigate(callback: (direction: 'prev' | 'next') => void) {
    this.drcPanelComponent?.setOnDrcNavigate(callback);
  }

  public setOnDrcSelect(callback: (index: number) => void) {
    this.drcPanelComponent?.setOnDrcSelect(callback);
  }

  public setOnDrcClear(callback: () => void) {
    this.drcPanelComponent?.setOnDrcClear(callback);
  }

  public setOnIncrementalDrc(callback: () => void) {
    this.drcPanelComponent?.setOnIncrementalDrc(callback);
  }

  public updateDrcPanel(regionCount: number, currentIndex: number, currentRegion: DrcRegion | null, showNav = true) {
    this.drcPanelComponent?.update(regionCount, currentIndex, currentRegion, showNav);
  }

  public resetDrcPanel() {
    this.drcPanelComponent?.reset();
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
        <button type="button" data-layer-action="all" style="padding:2px 6px; background: #3c3c3c; color: #ccc; border: 1px solid #5a5a5a; border-radius: 2px; cursor: pointer;">All</button>
        <button type="button" data-layer-action="none" style="padding:2px 6px; background: #3c3c3c; color: #ccc; border: 1px solid #5a5a5a; border-radius: 2px; cursor: pointer;">None</button>
        <button type="button" data-layer-action="invert" style="padding:2px 6px; background: #3c3c3c; color: #ccc; border: 1px solid #5a5a5a; border-radius: 2px; cursor: pointer;">Invert</button>
        <button type="button" id="savePcbBtn" style="padding:2px 6px; background: #0e639c; color: #fff; border: none; border-radius: 2px; cursor: pointer;">Save</button>
      </div>
    `);

    const entries = this.scene.layerOrder.map((layerId) => [layerId, this.scene.getLayerColor(layerId)] as const);

    // Scrollable layer list with max height
    legendParts.push(`<div style="max-height: 400px; overflow-y: auto; margin-right: -5px; padding-right: 5px;">`);
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
            this.scene.toggleLayerVisibility(layerId, true);
          }
        } else if (action === "none") {
          for (const layerId of this.scene.layerColors.keys()) {
            this.scene.toggleLayerVisibility(layerId, false);
          }
        } else if (action === "invert") {
          for (const layerId of this.scene.layerColors.keys()) {
            const currentVisible = this.scene.layerVisible.get(layerId) !== false;
            this.scene.toggleLayerVisibility(layerId, !currentVisible);
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
        this.openColorPicker(layerId, current);
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
        <input type="checkbox" data-layer-toggle="${layerId}" ${checked} style="margin:0; accent-color: #007acc;" />
        <button type="button" data-layer-color="${layerId}" title="Change color" style="width:18px;height:18px;border:1px solid #444;border-radius:2px;background:${rgb};cursor:pointer;"></button>
        <span style="flex:1 1 auto; font-size:11px; color: #ccc;">${label}</span>
      </div>
    `;
  }

  private openColorPicker(layerId: string, currentColor: LayerColor) {
    showColorPicker(
      layerId,
      currentColor,
      (color) => {
        this.scene.setLayerColor(layerId, color);
        this.notifyColorChange(layerId, color);
        this.refreshLayerLegend();
      },
      () => {
        this.scene.resetLayerColor(layerId);
        this.refreshLayerLegend();
      }
    );
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

    // Add Rust LSP memory stats if available
    if (this.rustMemoryBytes !== null) {
      const rustMB = (this.rustMemoryBytes / 1048576).toFixed(2);
      lines.push(`Rust Heap: ${rustMB} MB`);
    }

    this.fpsEl.innerHTML = lines.join("<br/>");
  }

  public setRustMemory(bytes: number | null) {
    this.rustMemoryBytes = bytes;
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

  public setDebugOverlay(overlay: DebugOverlay | null) {
    this.debugOverlay = overlay;
    // Sync checkbox state with overlay
    if (overlay && this.debugCoordsCheckbox) {
      this.debugCoordsCheckbox.checked = overlay.isEnabled();
    }
  }

  private debugCoordsCheckbox: HTMLInputElement | null = null;

  private addDebugCoordsCheckbox() {
    const fpsEl = document.getElementById("fps");
    if (!fpsEl) return;

    const container = document.createElement('div');
    container.style.marginTop = '8px';
    container.style.borderTop = '1px solid #444';
    container.style.paddingTop = '8px';

    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.style.cursor = 'pointer';
    label.style.fontSize = '11px';
    label.style.color = '#aaa';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    checkbox.style.margin = '0';
    checkbox.style.cursor = 'pointer';

    this.debugCoordsCheckbox = checkbox;

    checkbox.addEventListener('change', () => {
      if (this.debugOverlay) {
        this.debugOverlay.setVisible(checkbox.checked);
        this.scene.state.needsDraw = true;
      }
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode('Show Pad Coordinates'));
    container.appendChild(label);

    fpsEl.parentElement?.insertBefore(container, fpsEl.nextSibling);
  }

  /**
   * Update layer visibility checkboxes to match a set of visible layers.
   * Used by "Show only Selected Net Layers" feature.
   */
  public updateLayerVisibility(visibleLayerIds: Set<string>) {
    this.layersEl?.querySelectorAll<HTMLInputElement>("input[data-layer-toggle]").forEach((checkbox) => {
      const layerId = checkbox.dataset.layerToggle;
      if (layerId) {
        checkbox.checked = visibleLayerIds.has(layerId);
      }
    });
  }
}

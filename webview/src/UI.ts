import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { LayerColor, DrcRegion } from "./types";
import { DebugOverlay } from "./DebugOverlay";

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

  // DRC UI elements
  private drcPanel: HTMLDivElement | null = null;
  private drcCountLabel: HTMLSpanElement | null = null;
  private drcInfoLabel: HTMLDivElement | null = null;
  private drcListContainer: HTMLDivElement | null = null;
  private drcListVisible = false;
  private onRunDrc: (() => void) | null = null;
  private onDrcNavigate: ((direction: 'prev' | 'next') => void) | null = null;
  private onDrcSelect: ((index: number) => void) | null = null;
  private onClearDrc: (() => void) | null = null;

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
    this.createDebugControls();
    this.setupStatsToggle();
    this.setupLayerResize();
  }

  private setupStatsToggle() {
    const statsHeader = document.getElementById('stats-header');
    const statsContent = document.getElementById('stats-content');
    if (!statsHeader || !statsContent) return;

    statsHeader.addEventListener('click', () => {
      const isExpanded = statsContent.classList.contains('expanded');
      if (isExpanded) {
        statsContent.classList.remove('expanded');
        statsHeader.querySelector('.collapse-icon')!.textContent = '▶';
      } else {
        statsContent.classList.add('expanded');
        statsHeader.querySelector('.collapse-icon')!.textContent = '▼';
      }
    });
  }

  private setupLayerResize() {
    const resizeHandle = document.getElementById('layer-resize-handle');
    const layersEl = this.layersEl;
    if (!resizeHandle || !layersEl) return;

    // Find the scrollable layer list div (created in refreshLayerLegend)
    let isDragging = false;
    let startY = 0;
    let startHeight = 400; // Default max-height

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      startY = e.clientY;
      
      // Get current height from the inner scrollable div
      const scrollDiv = layersEl.querySelector('div[style*="overflow-y"]') as HTMLDivElement;
      if (scrollDiv) {
        const currentMaxHeight = parseInt(scrollDiv.style.maxHeight) || 400;
        startHeight = currentMaxHeight;
      }

      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaY = e.clientY - startY;
      const newHeight = Math.max(100, Math.min(800, startHeight + deltaY));

      // Apply to the scrollable div inside layers
      const scrollDiv = layersEl.querySelector('div[style*="overflow-y"]') as HTMLDivElement;
      if (scrollDiv) {
        scrollDiv.style.maxHeight = `${newHeight}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
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


  private createDebugControls() {
    if (!this.layersEl) return;

    const debugContainer = document.createElement('div');
    debugContainer.style.marginTop = '10px';
    debugContainer.style.borderTop = '1px solid #444';
    debugContainer.style.paddingTop = '5px';
    debugContainer.style.pointerEvents = 'auto';
    debugContainer.innerHTML = `
      <div style="margin-bottom: 5px; font-weight: bold;">Debug Render</div>
      <select id="debugRenderType" style="width: 100%; background: #333; color: white; border: 1px solid #555; margin-bottom: 5px;">
        <option value="all">All Geometry</option>
        <option value="batch">Polylines Only (Batch)</option>
        <option value="instanced">Vias Only (Instanced)</option>
        <option value="instanced_rot">Pads Only (InstancedRot)</option>
      </select>
      <button id="debugLogFrame" style="width: 100%; background: #444; color: white; border: 1px solid #555; cursor: pointer;">Log Next Frame</button>
    `;

    this.layersEl.parentElement?.insertBefore(debugContainer, this.layersEl.nextSibling);

    const select = debugContainer.querySelector('#debugRenderType') as HTMLSelectElement;
    select.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as any;
      this.renderer.debugRenderType = val;
      this.scene.state.needsDraw = true;
    });

    const btn = debugContainer.querySelector('#debugLogFrame') as HTMLButtonElement;
    btn.addEventListener('click', () => {
      this.renderer.debugLogNextFrame = true;
      this.scene.state.needsDraw = true;
      console.log("Next frame will be logged to console...");
    });

    // Create DRC panel after debug controls
    this.createDrcPanel(debugContainer);
  }

  private createDrcPanel(afterElement: HTMLElement) {
    this.drcPanel = document.createElement('div');
    this.drcPanel.style.marginTop = '10px';
    this.drcPanel.style.borderTop = '1px solid #444';
    this.drcPanel.style.paddingTop = '5px';
    this.drcPanel.style.pointerEvents = 'auto';
    this.drcPanel.innerHTML = `
      <div style="margin-bottom: 5px; font-weight: bold; color: #ff6b6b;">⚠️ DRC Violations</div>
      <button id="runDrcBtn" style="width: 100%; background: #ff4444; color: white; border: 1px solid #cc3333; padding: 6px; margin-bottom: 5px; cursor: pointer; border-radius: 3px;">Run DRC</button>
      <div id="drcProgress" style="display: none; margin-bottom: 5px; font-size: 11px; color: #aaa;">
        <span>⏳ Checking clearances...</span>
      </div>
      <div id="drcSummary" style="display: none; margin-bottom: 5px; cursor: pointer; padding: 6px; background: #2a2a2a; border-radius: 3px; border: 1px solid #444;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span id="drcCount" style="font-size: 12px; color: #ff6b6b; font-weight: bold;">0 violations found</span>
          <span id="drcExpandIcon" style="color: #888;">▼</span>
        </div>
      </div>
      <div id="drcListContainer" style="display: none; max-height: 250px; overflow-y: auto; background: #1a1a1a; border: 1px solid #444; border-radius: 3px; margin-bottom: 5px;">
        <div id="drcListHeader" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: #2a2a2a; border-bottom: 1px solid #444; position: sticky; top: 0;">
          <span style="font-size: 11px; color: #aaa;">Select violation:</span>
          <button id="drcCloseListBtn" style="background: none; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
        </div>
        <div id="drcList" style="padding: 4px;"></div>
      </div>
      <div id="drcNavContainer" style="display: none; margin-bottom: 5px;">
        <div style="display: flex; gap: 4px;">
          <button id="drcPrevBtn" style="flex: 1; background: #444; color: white; border: 1px solid #555; padding: 4px; cursor: pointer;">◀ Prev</button>
          <button id="drcNextBtn" style="flex: 1; background: #444; color: white; border: 1px solid #555; padding: 4px; cursor: pointer;">Next ▶</button>
        </div>
        <div id="drcViolationInfo" style="margin-top: 5px; font-size: 10px; color: #ccc; background: #2a2a2a; padding: 5px; border-radius: 3px;"></div>
      </div>
      <button id="clearDrcBtn" style="width: 100%; background: #333; color: #aaa; border: 1px solid #555; padding: 4px; cursor: pointer; display: none;">Clear DRC</button>
    `;

    afterElement.parentElement?.insertBefore(this.drcPanel, afterElement.nextSibling);

    // Wire up buttons
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    runBtn.addEventListener('click', () => {
      if (this.onRunDrc) {
        this.showDrcProgress();
        this.onRunDrc();
      }
    });

    // Summary click to toggle list
    const summaryDiv = this.drcPanel.querySelector('#drcSummary') as HTMLDivElement;
    summaryDiv.addEventListener('click', () => {
      this.toggleDrcList();
    });

    // Close list button
    const closeListBtn = this.drcPanel.querySelector('#drcCloseListBtn') as HTMLButtonElement;
    closeListBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideDrcList();
    });

    const prevBtn = this.drcPanel.querySelector('#drcPrevBtn') as HTMLButtonElement;
    prevBtn.addEventListener('click', () => {
      if (this.onDrcNavigate) this.onDrcNavigate('prev');
    });

    const nextBtn = this.drcPanel.querySelector('#drcNextBtn') as HTMLButtonElement;
    nextBtn.addEventListener('click', () => {
      if (this.onDrcNavigate) this.onDrcNavigate('next');
    });

    const clearBtn = this.drcPanel.querySelector('#clearDrcBtn') as HTMLButtonElement;
    clearBtn.addEventListener('click', () => {
      if (this.onClearDrc) this.onClearDrc();
    });

    this.drcCountLabel = this.drcPanel.querySelector('#drcCount') as HTMLSpanElement;
    this.drcInfoLabel = this.drcPanel.querySelector('#drcViolationInfo') as HTMLDivElement;
    this.drcListContainer = this.drcPanel.querySelector('#drcListContainer') as HTMLDivElement;
  }

  public showDrcProgress() {
    if (!this.drcPanel) return;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    const progressDiv = this.drcPanel.querySelector('#drcProgress') as HTMLDivElement;
    
    runBtn.style.display = 'none';
    progressDiv.style.display = 'block';
  }

  public hideDrcProgress() {
    if (!this.drcPanel) return;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    const progressDiv = this.drcPanel.querySelector('#drcProgress') as HTMLDivElement;
    
    runBtn.style.display = 'block';
    progressDiv.style.display = 'none';
  }

  private toggleDrcList() {
    if (this.drcListVisible) {
      this.hideDrcList();
    } else {
      this.showDrcList();
    }
  }

  private showDrcList() {
    if (!this.drcPanel || !this.drcListContainer) return;
    this.drcListVisible = true;
    this.drcListContainer.style.display = 'block';
    const expandIcon = this.drcPanel.querySelector('#drcExpandIcon') as HTMLSpanElement;
    if (expandIcon) expandIcon.textContent = '▲';
  }

  private hideDrcList() {
    if (!this.drcPanel || !this.drcListContainer) return;
    this.drcListVisible = false;
    this.drcListContainer.style.display = 'none';
    const expandIcon = this.drcPanel.querySelector('#drcExpandIcon') as HTMLSpanElement;
    if (expandIcon) expandIcon.textContent = '▼';
  }

  public populateDrcList(regions: DrcRegion[]) {
    if (!this.drcPanel) return;
    const listDiv = this.drcPanel.querySelector('#drcList') as HTMLDivElement;
    if (!listDiv) return;

    listDiv.innerHTML = '';
    
    regions.forEach((region, index) => {
      const netA = region.net_a || 'unnamed';
      const netB = region.net_b || 'unnamed';
      const item = document.createElement('div');
      item.className = 'drc-list-item';
      item.dataset.index = String(index);
      item.style.cssText = 'padding: 6px 8px; border-bottom: 1px solid #333; cursor: pointer; font-size: 10px;';
      item.innerHTML = `
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #aaa;">#${index + 1}</span>
          <span style="color: #ff6b6b; font-weight: bold;">${region.min_distance_mm.toFixed(3)}mm</span>
        </div>
        <div style="color: #888; margin-top: 2px;">${region.layer_id.replace('LAYER:', '')}</div>
        <div style="color: #666; margin-top: 1px; font-size: 9px;">${netA} ↔ ${netB}</div>
      `;
      
      item.addEventListener('mouseenter', () => {
        item.style.background = '#333';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('click', () => {
        if (this.onDrcSelect) {
          this.onDrcSelect(index);
          this.hideDrcList();
        }
      });
      
      listDiv.appendChild(item);
    });
  }

  public setOnRunDrc(callback: () => void) {
    this.onRunDrc = callback;
  }

  public setOnDrcNavigate(callback: (direction: 'prev' | 'next') => void) {
    this.onDrcNavigate = callback;
  }

  public setOnDrcSelect(callback: (index: number) => void) {
    this.onDrcSelect = callback;
  }

  public setOnClearDrc(callback: () => void) {
    this.onClearDrc = callback;
  }

  public updateDrcPanel(regionCount: number, currentIndex: number, currentRegion: DrcRegion | null, showNav = true) {
    if (!this.drcPanel) return;

    this.hideDrcProgress();

    const summaryDiv = this.drcPanel.querySelector('#drcSummary') as HTMLDivElement;
    const navContainer = this.drcPanel.querySelector('#drcNavContainer') as HTMLDivElement;
    const clearBtn = this.drcPanel.querySelector('#clearDrcBtn') as HTMLButtonElement;

    if (regionCount > 0) {
      summaryDiv.style.display = 'block';
      clearBtn.style.display = 'block';

      if (this.drcCountLabel) {
        this.drcCountLabel.textContent = `${regionCount} clearance violation${regionCount !== 1 ? 's' : ''} found`;
      }

      // Show navigation only if explicitly navigating
      if (showNav && currentRegion) {
        navContainer.style.display = 'block';
        
        if (this.drcInfoLabel) {
          const netA = currentRegion.net_a || 'unnamed';
          const netB = currentRegion.net_b || 'unnamed';
          this.drcInfoLabel.innerHTML = `
            <div style="margin-bottom: 3px; color: #888;">${currentIndex + 1} / ${regionCount}</div>
            <div>Layer: <b>${currentRegion.layer_id}</b></div>
            <div>Distance: <b style="color:#ff6b6b;">${currentRegion.min_distance_mm.toFixed(3)}mm</b> (req: ${currentRegion.clearance_mm.toFixed(3)}mm)</div>
            <div>Nets: <b>${netA}</b> ↔ <b>${netB}</b></div>
            <div>Triangles: ${currentRegion.triangle_count}</div>
          `;
        }
      } else {
        navContainer.style.display = 'none';
      }
    } else {
      summaryDiv.style.display = 'none';
      navContainer.style.display = 'none';
      clearBtn.style.display = 'none';
    }
  }

  public resetDrcPanel() {
    if (!this.drcPanel) return;

    this.hideDrcProgress();
    this.hideDrcList();

    const summaryDiv = this.drcPanel.querySelector('#drcSummary') as HTMLDivElement;
    const navContainer = this.drcPanel.querySelector('#drcNavContainer') as HTMLDivElement;
    const clearBtn = this.drcPanel.querySelector('#clearDrcBtn') as HTMLButtonElement;
    const listDiv = this.drcPanel.querySelector('#drcList') as HTMLDivElement;
    
    summaryDiv.style.display = 'none';
    navContainer.style.display = 'none';
    clearBtn.style.display = 'none';
    if (listDiv) listDiv.innerHTML = '';
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
    this.layersEl.querySelectorAll<HTMLInputElement>("input[data-layer-toggle]").forEach((checkbox) => {
      const layerId = checkbox.dataset.layerToggle;
      if (layerId) {
        checkbox.checked = visibleLayerIds.has(layerId);
      }
    });
  }
}

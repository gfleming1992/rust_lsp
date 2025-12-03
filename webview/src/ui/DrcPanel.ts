import { DrcRegion } from "../types";

export interface DrcPanelCallbacks {
  onRunDrc: (() => void) | null;
  onRunIncrementalDrc: (() => void) | null;
  onDrcNavigate: ((direction: 'prev' | 'next') => void) | null;
  onDrcSelect: ((index: number) => void) | null;
  onDrcClear: (() => void) | null;
}

/** DRC Panel UI component - creates and manages the DRC violations panel */
export class DrcPanel {
  private drcPanel: HTMLDivElement | null = null;
  private drcCountLabel: HTMLSpanElement | null = null;
  private drcListContainer: HTMLDivElement | null = null;
  private callbacks: DrcPanelCallbacks = {
    onRunDrc: null,
    onRunIncrementalDrc: null,
    onDrcNavigate: null,
    onDrcSelect: null,
    onDrcClear: null,
  };

  constructor(private parentEl: HTMLElement) {}

  public create() {
    // Create resize handle between layers and DRC
    const resizeHandle = document.createElement('div');
    resizeHandle.id = 'layer-resize-handle';
    resizeHandle.title = 'Drag to resize';
    resizeHandle.style.cssText = 'height: 6px; background: linear-gradient(to bottom, transparent 0px, #3c3c3c 2px, #3c3c3c 4px, transparent 6px); cursor: ns-resize; margin: 8px 0;';
    this.parentEl.parentElement?.insertBefore(resizeHandle, this.parentEl.nextSibling);

    // Create DRC panel after resize handle
    this.drcPanel = document.createElement('div');
    this.drcPanel.className = 'drc-panel';
    this.drcPanel.style.marginTop = '0';
    this.drcPanel.style.paddingTop = '5px';
    this.drcPanel.style.pointerEvents = 'auto';
    this.drcPanel.innerHTML = `
      <div id="drcHeader" style="display: flex; align-items: center; gap: 4px; margin-bottom: 5px; cursor: pointer; user-select: none; padding: 2px 0;">
        <span id="drcCollapseIcon" style="color: #888; font-size: 10px; width: 12px; text-align: center;">▼</span>
        <span style="font-weight: bold; color: #cca700;">⚠ DRC Violations</span>
      </div>
      <div id="drcContent">
        <button id="runDrcBtn" style="width: 100%; background: #0e639c; color: #fff; border: none; padding: 6px; margin-bottom: 5px; cursor: pointer; border-radius: 2px;">Run DRC</button>
        <div id="drcProgress" style="display: none; margin-bottom: 5px; font-size: 11px; color: #aaa;">
          <span>⏳ Checking clearances...</span>
        </div>
        <div id="drcResultsContainer" style="display: none;">
          <div id="drcSummaryHeader" style="padding: 6px 8px; background: #2a2a2a; border: 1px solid #444; border-bottom: none; border-radius: 2px 2px 0 0; font-size: 11px;">
            <span id="drcCount" style="color: #cca700; font-weight: bold;">0 violations found</span>
            <span style="color: #666; margin-left: 8px; font-size: 10px;">↑↓ to navigate</span>
          </div>
          <div id="drcListContainer" style="max-height: 200px; overflow-y: auto; background: #1a1a1a; border: 1px solid #444; border-bottom: none;" tabindex="0">
            <div id="drcList" style=""></div>
          </div>
          <div id="drcDetailPanel" style="background: #2a2a2a; border: 1px solid #444; border-radius: 0 0 2px 2px; padding: 8px; font-size: 10px; display: none;">
            <div id="drcDetailIndex" style="color: #888; margin-bottom: 4px;"></div>
            <div id="drcDetailLayer" style="color: #ccc; margin-bottom: 2px;"></div>
            <div id="drcDetailDistance" style="margin-bottom: 2px;">
              Distance: <span id="drcDistanceValue" style="color: #cca700; font-weight: bold;"></span>
              <span style="color: #666;">(req: <span id="drcRequiredValue"></span>)</span>
            </div>
            <div id="drcDetailNets" style="color: #888;"></div>
            <div id="drcDetailTriangles" style="color: #666; margin-top: 2px;"></div>
          </div>
          <div style="display: flex; gap: 4px; margin-top: 5px;">
            <button id="rerunFullDrcBtn" style="flex: 1; background: #0e639c; color: #fff; border: none; padding: 5px 8px; cursor: pointer; border-radius: 2px; font-size: 11px;">Run Full DRC</button>
            <button id="rerunIncrementalDrcBtn" style="flex: 1; background: #3c3c3c; color: #ccc; border: 1px solid #5a5a5a; padding: 5px 8px; cursor: pointer; border-radius: 2px; font-size: 11px;">Run Incremental</button>
          </div>
        </div>
      </div>
    `;

    resizeHandle.parentElement?.insertBefore(this.drcPanel, resizeHandle.nextSibling);

    // Create bottom resize handle after DRC panel
    const bottomResizeHandle = document.createElement('div');
    bottomResizeHandle.id = 'drc-resize-handle';
    bottomResizeHandle.title = 'Drag to resize DRC list';
    bottomResizeHandle.style.cssText = 'height: 6px; background: linear-gradient(to bottom, transparent 0px, #3c3c3c 2px, #3c3c3c 4px, transparent 6px); cursor: ns-resize; margin: 8px 0;';
    this.drcPanel.parentElement?.insertBefore(bottomResizeHandle, this.drcPanel.nextSibling);

    this.setupEventListeners();
    
    this.drcCountLabel = this.drcPanel.querySelector('#drcCount') as HTMLSpanElement;
    this.drcListContainer = this.drcPanel.querySelector('#drcListContainer') as HTMLDivElement;
  }

  private setupEventListeners() {
    if (!this.drcPanel) return;

    // Collapse/expand header
    const drcHeader = this.drcPanel.querySelector('#drcHeader') as HTMLDivElement;
    const drcContent = this.drcPanel.querySelector('#drcContent') as HTMLDivElement;
    const collapseIcon = this.drcPanel.querySelector('#drcCollapseIcon') as HTMLSpanElement;
    
    drcHeader.addEventListener('click', () => {
      const isCollapsed = drcContent.style.display === 'none';
      drcContent.style.display = isCollapsed ? 'block' : 'none';
      collapseIcon.textContent = isCollapsed ? '▼' : '▶';
    });

    drcHeader.addEventListener('mouseenter', () => { drcHeader.style.background = '#2a2a2a'; });
    drcHeader.addEventListener('mouseleave', () => { drcHeader.style.background = 'transparent'; });

    // Run DRC buttons
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    runBtn.addEventListener('click', () => {
      if (this.callbacks.onRunDrc) {
        this.showProgress();
        this.callbacks.onRunDrc();
      }
    });

    const rerunFullBtn = this.drcPanel.querySelector('#rerunFullDrcBtn') as HTMLButtonElement;
    rerunFullBtn.addEventListener('click', () => {
      if (this.callbacks.onRunDrc) {
        this.showProgress();
        this.callbacks.onRunDrc();
      }
    });

    const rerunIncrementalBtn = this.drcPanel.querySelector('#rerunIncrementalDrcBtn') as HTMLButtonElement;
    rerunIncrementalBtn.addEventListener('click', () => {
      if (this.callbacks.onRunIncrementalDrc) {
        this.showProgress();
        this.callbacks.onRunIncrementalDrc();
      }
    });

    // Keyboard navigation
    const listContainer = this.drcPanel.querySelector('#drcListContainer') as HTMLDivElement;
    listContainer.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.callbacks.onDrcNavigate) this.callbacks.onDrcNavigate('prev');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.callbacks.onDrcNavigate) this.callbacks.onDrcNavigate('next');
      }
    });
  }

  // ==================== Callback Setters ====================

  public setOnRunDrc(callback: () => void) { this.callbacks.onRunDrc = callback; }
  public setOnIncrementalDrc(callback: () => void) { this.callbacks.onRunIncrementalDrc = callback; }
  public setOnDrcNavigate(callback: (direction: 'prev' | 'next') => void) { this.callbacks.onDrcNavigate = callback; }
  public setOnDrcSelect(callback: (index: number) => void) { this.callbacks.onDrcSelect = callback; }
  public setOnDrcClear(callback: () => void) { this.callbacks.onDrcClear = callback; }

  // ==================== Progress ====================

  public showProgress() {
    if (!this.drcPanel) return;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    const progressDiv = this.drcPanel.querySelector('#drcProgress') as HTMLDivElement;
    const resultsContainer = this.drcPanel.querySelector('#drcResultsContainer') as HTMLDivElement;
    
    runBtn.style.display = 'none';
    progressDiv.style.display = 'block';
    resultsContainer.style.display = 'none';
  }

  public hideProgress() {
    if (!this.drcPanel) return;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    const progressDiv = this.drcPanel.querySelector('#drcProgress') as HTMLDivElement;
    
    runBtn.style.display = 'block';
    progressDiv.style.display = 'none';
  }

  // ==================== List Management ====================

  public populateList(regions: DrcRegion[]) {
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
      item.style.cssText = 'padding: 6px 8px; border-bottom: 1px solid #333; cursor: pointer; font-size: 10px; display: flex; justify-content: space-between; align-items: center;';
      item.innerHTML = `
        <div>
          <span style="color: #888; margin-right: 6px;">#${index + 1}</span>
          <span style="color: #aaa;">${region.layer_id.replace('LAYER:', '')}</span>
        </div>
        <span style="color: #cca700; font-weight: bold;">${region.min_distance_mm.toFixed(3)}mm</span>
      `;
      
      item.addEventListener('click', () => {
        if (this.callbacks.onDrcSelect) this.callbacks.onDrcSelect(index);
      });
      
      listDiv.appendChild(item);
    });

    this.drcListContainer?.focus();
  }

  public highlightListItem(index: number) {
    if (!this.drcPanel) return;
    const listDiv = this.drcPanel.querySelector('#drcList') as HTMLDivElement;
    if (!listDiv) return;

    listDiv.querySelectorAll('.drc-list-item').forEach((item) => {
      (item as HTMLDivElement).style.background = 'transparent';
      (item as HTMLDivElement).style.borderLeft = 'none';
    });

    const selectedItem = listDiv.querySelector(`[data-index="${index}"]`) as HTMLDivElement;
    if (selectedItem) {
      selectedItem.style.background = '#094771';
      selectedItem.style.borderLeft = '3px solid #007acc';
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  public clearHighlight() {
    if (!this.drcPanel) return;
    
    const listDiv = this.drcPanel.querySelector('#drcList') as HTMLDivElement;
    if (listDiv) {
      listDiv.querySelectorAll('.drc-list-item').forEach((item) => {
        (item as HTMLDivElement).style.background = 'transparent';
        (item as HTMLDivElement).style.borderLeft = 'none';
      });
    }
    
    const detailPanel = this.drcPanel.querySelector('#drcDetailPanel') as HTMLDivElement;
    if (detailPanel) detailPanel.style.display = 'none';
    
    if (this.callbacks.onDrcClear) this.callbacks.onDrcClear();
  }

  // ==================== Panel Update ====================

  public update(regionCount: number, currentIndex: number, currentRegion: DrcRegion | null, showNav = true) {
    if (!this.drcPanel) return;

    this.hideProgress();

    const resultsContainer = this.drcPanel.querySelector('#drcResultsContainer') as HTMLDivElement;
    const detailPanel = this.drcPanel.querySelector('#drcDetailPanel') as HTMLDivElement;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;

    if (regionCount > 0) {
      runBtn.style.display = 'none';
      resultsContainer.style.display = 'block';

      if (this.drcCountLabel) {
        this.drcCountLabel.textContent = `${regionCount} clearance violation${regionCount !== 1 ? 's' : ''} found`;
      }

      if (currentRegion) {
        detailPanel.style.display = 'block';
        
        const netA = currentRegion.net_a || 'unnamed';
        const netB = currentRegion.net_b || 'unnamed';
        
        const indexEl = this.drcPanel.querySelector('#drcDetailIndex') as HTMLDivElement;
        const layerEl = this.drcPanel.querySelector('#drcDetailLayer') as HTMLDivElement;
        const distanceEl = this.drcPanel.querySelector('#drcDistanceValue') as HTMLSpanElement;
        const requiredEl = this.drcPanel.querySelector('#drcRequiredValue') as HTMLSpanElement;
        const netsEl = this.drcPanel.querySelector('#drcDetailNets') as HTMLDivElement;
        const trianglesEl = this.drcPanel.querySelector('#drcDetailTriangles') as HTMLDivElement;
        
        if (indexEl) indexEl.textContent = `Violation ${currentIndex + 1} of ${regionCount}`;
        if (layerEl) layerEl.textContent = `Layer: ${currentRegion.layer_id}`;
        if (distanceEl) distanceEl.textContent = `${currentRegion.min_distance_mm.toFixed(3)}mm`;
        if (requiredEl) requiredEl.textContent = `${currentRegion.clearance_mm.toFixed(3)}mm`;
        if (netsEl) netsEl.textContent = `Nets: ${netA} ↔ ${netB}`;
        if (trianglesEl) trianglesEl.textContent = `Triangles: ${currentRegion.triangle_count}`;
        
        this.highlightListItem(currentIndex);
      } else {
        detailPanel.style.display = 'none';
      }
    } else {
      resultsContainer.style.display = 'none';
      runBtn.style.display = 'block';
    }
  }

  public reset() {
    if (!this.drcPanel) return;

    this.hideProgress();

    const resultsContainer = this.drcPanel.querySelector('#drcResultsContainer') as HTMLDivElement;
    const runBtn = this.drcPanel.querySelector('#runDrcBtn') as HTMLButtonElement;
    const listDiv = this.drcPanel.querySelector('#drcList') as HTMLDivElement;
    
    resultsContainer.style.display = 'none';
    runBtn.style.display = 'block';
    if (listDiv) listDiv.innerHTML = '';
  }
}

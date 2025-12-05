import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { ContextMenu } from "./ui/ContextMenu";
import { Tooltip } from "./ui/Tooltip";
import { ObjectRange } from "./types";

export class Input {
  private scene: Scene;
  private renderer: Renderer;
  private ui: UI;
  private canvas: HTMLCanvasElement;
  private onSelect: (x: number, y: number, ctrlKey: boolean) => void;
  private contextMenu: ContextMenu;
  private tooltip: Tooltip;

  private haveMouse = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartWorldX = 0;
  private dragStartWorldY = 0;

  private ZOOM_SPEED = 0.005;
  private MIN_ZOOM = 0.1;
  private MAX_ZOOM = 500;

  private selectionBox: HTMLDivElement;
  private onDelete: (() => void) | null = null;
  private onUndo: (() => void) | null = null;
  private onRedo: (() => void) | null = null;
  private onBoxSelect: ((minX: number, minY: number, maxX: number, maxY: number) => void) | null = null;
  private onHighlightNets: (() => void) | null = null;
  private onClearSelection: (() => void) | null = null;
  
  // Move mode state - click-to-pick-up, click-to-drop (no drag required)
  private isMoving = false;           // True when object is following mouse
  private moveStartWorldX = 0;        // World position when move started
  private moveStartWorldY = 0;
  private onMoveStart: (() => void) | null = null;
  private onMoveUpdate: ((deltaX: number, deltaY: number) => void) | null = null;
  private onMoveEnd: ((deltaX: number, deltaY: number) => void) | null = null;
  private onMoveCancel: (() => void) | null = null;
  private getSelectedObjects: (() => ObjectRange[]) | null = null;
  
  // Rotation callback
  private onRotate: ((angleDelta: number) => void) | null = null;
  private rotationEnabled = false; // Only true when single component is fully selected
  
  /** Check if currently in move mode (object following mouse) */
  public getIsMoving(): boolean {
    return this.isMoving;
  }
  
  // Hover tooltip tracking
  private hoverTimer: number | null = null;
  private hoverDelayMs = 500; // 0.5 second delay
  private onQueryNetAtPoint: ((worldX: number, worldY: number, clientX: number, clientY: number) => void) | null = null;
  private lastClickCtrlKey = false; // Track if Ctrl was held during click
  private lastClickX = 0; // Track click position for selection tooltip
  private lastClickY = 0;

  constructor(scene: Scene, renderer: Renderer, ui: UI, onSelect: (x: number, y: number, ctrlKey: boolean) => void) {
    this.scene = scene;
    this.renderer = renderer;
    this.ui = ui;
    this.canvas = renderer.canvas;
    this.onSelect = onSelect;
    
    this.contextMenu = new ContextMenu();
    this.tooltip = new Tooltip();
    
    this.selectionBox = document.createElement('div');
    this.selectionBox.style.position = 'fixed';
    this.selectionBox.style.border = '1px solid #007acc';
    this.selectionBox.style.backgroundColor = 'rgba(0, 122, 204, 0.1)';
    this.selectionBox.style.pointerEvents = 'none';
    this.selectionBox.style.display = 'none';
    this.selectionBox.style.zIndex = '1000';
    document.body.appendChild(this.selectionBox);

    this.setupListeners();
  }

  public setOnDelete(callback: () => void) {
    this.onDelete = callback;
  }

  public setOnUndo(callback: () => void) {
    this.onUndo = callback;
  }

  public setOnRedo(callback: () => void) {
    this.onRedo = callback;
  }

  public setOnBoxSelect(callback: (minX: number, minY: number, maxX: number, maxY: number) => void) {
    this.onBoxSelect = callback;
  }

  public setOnClearSelection(callback: () => void) {
    this.onClearSelection = callback;
  }

  public setOnHighlightNets(callback: () => void) {
    this.onHighlightNets = callback;
    this.contextMenu.setOnHighlightNets(callback);
  }

  public setOnHighlightComponents(callback: () => void) {
    this.contextMenu.setOnHighlightComponents(callback);
  }

  public setOnShowOnlySelectedNetLayers(callback: () => void) {
    this.contextMenu.setOnShowOnlySelectedNetLayers(callback);
  }

  public setHasSelection(hasSelection: boolean) {
    this.contextMenu.setHasSelection(hasSelection);
  }

  public setHasComponentSelection(hasComponentSelection: boolean) {
    this.contextMenu.setHasComponentSelection(hasComponentSelection);
  }

  public setHasNetSelection(hasNetSelection: boolean) {
    this.contextMenu.setHasNetSelection(hasNetSelection);
  }

  public setOnQueryNetAtPoint(callback: (worldX: number, worldY: number, clientX: number, clientY: number) => void) {
    this.onQueryNetAtPoint = callback;
  }

  // Move operation callbacks
  public setOnMoveStart(callback: () => void) {
    this.onMoveStart = callback;
  }

  public setOnMoveUpdate(callback: (deltaX: number, deltaY: number) => void) {
    this.onMoveUpdate = callback;
  }

  public setOnMoveEnd(callback: (deltaX: number, deltaY: number) => void) {
    this.onMoveEnd = callback;
  }

  public setOnMoveCancel(callback: () => void) {
    this.onMoveCancel = callback;
  }

  public setGetSelectedObjects(callback: () => ObjectRange[]) {
    this.getSelectedObjects = callback;
  }

  public setOnRotate(callback: (angleDelta: number) => void) {
    this.onRotate = callback;
  }

  /**
   * Enable or disable rotation. Rotation is only enabled when:
   * - A single component is selected (via HighlightSelectedComponents)
   * - No other non-component objects are in the selection
   */
  public setRotationEnabled(enabled: boolean) {
    this.rotationEnabled = enabled;
    console.log(`[Input] Rotation ${enabled ? 'enabled' : 'disabled'}`);
  }

  public isRotationEnabled(): boolean {
    return this.rotationEnabled;
  }

  // Called by main.ts when user clicks on an already-selected object
  // This immediately starts move mode (object follows mouse until next click)
  public startMoveMode(worldX: number, worldY: number) {
    this.isMoving = true;
    this.moveStartWorldX = worldX;
    this.moveStartWorldY = worldY;
    this.canvas.style.cursor = "move";
    console.log(`[Input] Move mode started at (${worldX.toFixed(2)}, ${worldY.toFixed(2)}) - click to drop`);
    
    if (this.onMoveStart) {
      this.onMoveStart();
    }
  }

  // Called by main.ts to cancel move mode (e.g., on Escape)
  public cancelMoveMode() {
    if (this.isMoving) {
      console.log('[Input] Move mode cancelled');
      this.isMoving = false;
      this.canvas.style.cursor = "grab";
      if (this.onMoveCancel) {
        this.onMoveCancel();
      }
    }
  }
  
  /** Trigger move end callback directly (used for rotate-in-place finalization) */
  public triggerMoveEnd(deltaX: number, deltaY: number) {
    if (this.onMoveEnd) {
      this.onMoveEnd(deltaX, deltaY);
    }
  }

  public showNetTooltip(netName: string | null, clientX: number, clientY: number) {
    if (netName) {
      this.tooltip.show(clientX, clientY, `Net: ${netName}`);
    }
  }

  public showSelectionTooltip(info: { net?: string; component?: string; pin?: string }, clientX: number, clientY: number) {
    const lines: string[] = [];
    
    if (info.net) {
      lines.push(`<span style="color: #4fc3f7;">Net:</span> ${this.escapeHtml(info.net)}`);
    }
    if (info.component) {
      lines.push(`<span style="color: #81c784;">Component:</span> ${this.escapeHtml(info.component)}`);
    }
    if (info.pin) {
      lines.push(`<span style="color: #fff176;">Pin:</span> ${this.escapeHtml(info.pin)}`);
    }
    
    if (lines.length > 0) {
      this.tooltip.showHtml(clientX, clientY, lines.join('<br>'));
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  public hideTooltip() {
    this.tooltip.hide();
  }

  public getLastClickPosition(): { x: number; y: number } {
    return { x: this.lastClickX, y: this.lastClickY };
  }

  private startHoverTimer(clientX: number, clientY: number) {
    this.cancelHoverTimer();
    
    this.hoverTimer = window.setTimeout(() => {
      this.checkHoverObject(clientX, clientY);
    }, this.hoverDelayMs);
  }

  private cancelHoverTimer() {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.tooltip.hide();
  }

  private checkHoverObject(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const world = this.renderer.screenToWorld(cssX, cssY);
    
    // Query LSP server for net at this point
    if (this.onQueryNetAtPoint) {
      this.onQueryNetAtPoint(world.x, world.y, clientX, clientY);
    }
  }

  private setupListeners() {
    this.canvas.style.touchAction = "none";

    // Prevent default context menu on canvas
    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.contextMenu.show(event.clientX, event.clientY);
    });

    // Keyboard listeners for Delete, Undo, Redo, Escape
    // Note: Use metaKey for macOS (Cmd) and ctrlKey for Windows/Linux
    window.addEventListener('keydown', (event) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifierKey = isMac ? event.metaKey : event.ctrlKey;
      
      if (event.key === 'Escape') {
        event.preventDefault();
        // If in move mode, cancel the move first
        if (this.isMoving) {
          this.cancelMoveMode();
        } else if (this.onClearSelection) {
          this.onClearSelection();
        }
      } else if (event.key === 'Delete' || event.key === 'Backspace' || (modifierKey && (event.key === 'd' || event.key === 'D'))) {
        event.preventDefault();
        console.log('[Input] Delete key pressed');
        if (this.onDelete) {
          this.onDelete();
        }
      } else if (modifierKey && (event.key === 'z' || event.key === 'Z') && !event.shiftKey) {
        event.preventDefault();
        console.log('[Input] Undo pressed');
        if (this.onUndo) {
          this.onUndo();
        }
      } else if (modifierKey && ((event.key === 'y' || event.key === 'Y') || (event.shiftKey && (event.key === 'z' || event.key === 'Z')))) {
        // Redo: Ctrl+Y (Windows) or Cmd+Shift+Z (Mac)
        event.preventDefault();
        console.log('[Input] Redo pressed');
        if (this.onRedo) {
          this.onRedo();
        }
      } else if (event.key === 'r' || event.key === 'R') {
        // Rotate: R for 90° clockwise, Shift+R for 90° counter-clockwise
        // Only works when rotation is enabled (single component fully selected)
        if (!this.rotationEnabled) {
          console.log('[Input] Rotation disabled - select a single component first (press H after selecting)');
          return;
        }
        event.preventDefault();
        const angleDelta = event.shiftKey ? -Math.PI / 2 : Math.PI / 2; // ±90°
        console.log(`[Input] Rotate ${event.shiftKey ? 'CCW' : 'CW'} pressed`);
        if (this.onRotate) {
          this.onRotate(angleDelta);
        }
      }
    });

    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      
      // Calculate world coordinates
      const rect = this.canvas.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const world = this.renderer.screenToWorld(cssX, cssY);
      
      // If we're in move mode and left-click, DROP the object
      if (this.isMoving && event.button === 0) {
        const deltaX = world.x - this.moveStartWorldX;
        const deltaY = world.y - this.moveStartWorldY;
        
        console.log(`[Input] Move dropped at (${world.x.toFixed(2)}, ${world.y.toFixed(2)}), delta (${deltaX.toFixed(3)}, ${deltaY.toFixed(3)})`);
        
        if (this.onMoveEnd) {
          this.onMoveEnd(deltaX, deltaY);
        }
        
        this.isMoving = false;
        this.canvas.style.cursor = "grab";
        // Don't start a new selection - the click was just to drop
        return;
      }
      
      // Normal drag/selection handling
      this.scene.state.dragging = true;
      this.scene.state.dragButton = event.button;
      this.scene.state.lastX = event.clientX;
      this.scene.state.lastY = event.clientY;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.lastClickCtrlKey = event.ctrlKey;
      this.canvas.setPointerCapture(event.pointerId);
      this.dragStartWorldX = world.x;
      this.dragStartWorldY = world.y;
      
      if (event.button === 1) { // Middle mouse - Pan
        this.canvas.style.cursor = "grabbing";
      } else if (event.button === 0) { // Left mouse - Selection box
        this.canvas.style.cursor = "crosshair";
        this.selectionBox.style.display = 'block';
        this.selectionBox.style.left = `${event.clientX}px`;
        this.selectionBox.style.top = `${event.clientY}px`;
        this.selectionBox.style.width = '0px';
        this.selectionBox.style.height = '0px';
      }
    });

    this.canvas.addEventListener("pointermove", (event) => {
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
      this.haveMouse = true;
      
      // Calculate world coordinates
      const rect = this.canvas.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const world = this.renderer.screenToWorld(cssX, cssY);
      
      // If in move mode (click-to-pick-up), update preview continuously
      if (this.isMoving) {
        const deltaX = world.x - this.moveStartWorldX;
        const deltaY = world.y - this.moveStartWorldY;
        
        if (this.onMoveUpdate) {
          this.onMoveUpdate(deltaX, deltaY);
        }
        this.scene.state.needsDraw = true;
        this.cancelHoverTimer(); // No tooltips while moving
      } else if (!this.scene.state.dragging) {
        // Reset hover timer on mouse move (only when not dragging and not moving)
        this.startHoverTimer(event.clientX, event.clientY);
      } else {
        this.cancelHoverTimer();
      }
      
      if (this.scene.state.dragging) {
        const dx = event.clientX - this.scene.state.lastX;
        const dy = event.clientY - this.scene.state.lastY;
        this.scene.state.lastX = event.clientX;
        this.scene.state.lastY = event.clientY;
        
        if (this.scene.state.dragButton === 1) { // Middle mouse - Pan
          const dpr = window.devicePixelRatio || 1;
          this.scene.state.panX += (dx * dpr) / this.scene.state.zoom;
          this.scene.state.panY -= (dy * dpr) / this.scene.state.zoom;
          this.scene.state.needsDraw = true;
        } else if (this.scene.state.dragButton === 0) { // Left mouse - Selection Box
          const x = Math.min(event.clientX, this.dragStartX);
          const y = Math.min(event.clientY, this.dragStartY);
          const w = Math.abs(event.clientX - this.dragStartX);
          const h = Math.abs(event.clientY - this.dragStartY);
          
          this.selectionBox.style.left = `${x}px`;
          this.selectionBox.style.top = `${y}px`;
          this.selectionBox.style.width = `${w}px`;
          this.selectionBox.style.height = `${h}px`;
        }
      }
      
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    });

    const endDrag = (event: PointerEvent) => {
      if (!this.scene.state.dragging) return;
      
      // Check for click (minimal movement)
      const dist = Math.hypot(event.clientX - this.dragStartX, event.clientY - this.dragStartY);
      
      if (dist < 5 && this.scene.state.dragButton === 0) { // Left click only
        this.handleClick(event.clientX, event.clientY);
      } else if (dist >= 5 && this.scene.state.dragButton === 0) {
        // Multi-select box
        this.handleBoxSelect(this.dragStartX, this.dragStartY, event.clientX, event.clientY);
      }

      if (this.scene.state.dragButton === 0) {
        this.selectionBox.style.display = 'none';
      }

      this.scene.state.dragging = false;
      this.scene.state.dragButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      // Only reset cursor if not in move mode
      if (!this.isMoving) {
        this.canvas.style.cursor = "grab";
      }
    };

    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);

    this.canvas.addEventListener("mouseleave", () => {
      this.haveMouse = false;
      this.cancelHoverTimer();
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    });

    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const pivotWorld = this.renderer.screenToWorld(cssX, cssY);
      
      const factor = Math.exp(-event.deltaY * this.ZOOM_SPEED);
      this.scene.state.zoom = this.clamp(this.scene.state.zoom * factor, this.MIN_ZOOM, this.MAX_ZOOM);

      const width = Math.max(1, this.canvas.width);
      const height = Math.max(1, this.canvas.height);
      const fx = this.scene.state.flipX ? -1 : 1;
      const fy = this.scene.state.flipY ? -1 : 1;
      const scaleX = (2 * this.scene.state.zoom) / width;
      const scaleY = (2 * this.scene.state.zoom) / height;
      const xNdc = (2 * cssX) / Math.max(1, this.canvas.clientWidth) - 1;
      const yNdc = 1 - (2 * cssY) / Math.max(1, this.canvas.clientHeight);

      this.scene.state.panX = ((xNdc / fx + 1) / scaleX) - width / 2 - pivotWorld.x;
      this.scene.state.panY = ((1 - yNdc * fy) / scaleY) - height / 2 - pivotWorld.y;

      this.scene.state.needsDraw = true;
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    }, { passive: false });

    this.canvas.addEventListener("mousemove", () => {
      this.scene.state.needsDraw = true;
    });
  }

  private handleClick(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const world = this.renderer.screenToWorld(cssX, cssY);
    
    // Store click position for selection tooltip
    this.lastClickX = clientX;
    this.lastClickY = clientY;
    
    this.onSelect(world.x, world.y, this.lastClickCtrlKey);
  }

  private handleBoxSelect(startX: number, startY: number, endX: number, endY: number) {
    const rect = this.canvas.getBoundingClientRect();
    
    const start = this.renderer.screenToWorld(startX - rect.left, startY - rect.top);
    const end = this.renderer.screenToWorld(endX - rect.left, endY - rect.top);
    
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);
    
    console.log(`[Input] Box select: (${minX.toFixed(2)}, ${minY.toFixed(2)}) to (${maxX.toFixed(2)}, ${maxY.toFixed(2)})`);
    
    // Use callback if set
    if (this.onBoxSelect) {
      this.onBoxSelect(minX, minY, maxX, maxY);
    }
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }
}

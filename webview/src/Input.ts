import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";

export class Input {
  private scene: Scene;
  private renderer: Renderer;
  private ui: UI;
  private canvas: HTMLCanvasElement;
  private onSelect: (x: number, y: number) => void;

  private haveMouse = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  
  private dragStartX = 0;
  private dragStartY = 0;

  private ZOOM_SPEED = 0.005;
  private MIN_ZOOM = 0.1;
  private MAX_ZOOM = 500;

  private selectionBox: HTMLDivElement;
  private onDelete: (() => void) | null = null;
  private onUndo: (() => void) | null = null;
  private onRedo: (() => void) | null = null;
  private onBoxSelect: ((minX: number, minY: number, maxX: number, maxY: number) => void) | null = null;

  constructor(scene: Scene, renderer: Renderer, ui: UI, onSelect: (x: number, y: number) => void) {
    this.scene = scene;
    this.renderer = renderer;
    this.ui = ui;
    this.canvas = renderer.canvas;
    this.onSelect = onSelect;
    
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

  private setupListeners() {
    this.canvas.style.touchAction = "none";

    // Keyboard listeners for Delete, Undo, Redo
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || (event.ctrlKey && (event.key === 'd' || event.key === 'D'))) {
        event.preventDefault();
        console.log('[Input] Delete key pressed');
        if (this.onDelete) {
          this.onDelete();
        }
      } else if (event.ctrlKey && (event.key === 'z' || event.key === 'Z') && !event.shiftKey) {
        event.preventDefault();
        console.log('[Input] Undo (Ctrl+Z) pressed');
        if (this.onUndo) {
          this.onUndo();
        }
      } else if (event.ctrlKey && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        console.log('[Input] Redo (Ctrl+Y) pressed');
        if (this.onRedo) {
          this.onRedo();
        }
      }
    });

    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      
      this.scene.state.dragging = true;
      this.scene.state.dragButton = event.button;
      this.scene.state.lastX = event.clientX;
      this.scene.state.lastY = event.clientY;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
      
      if (event.button === 1) { // Middle mouse - Pan
        this.canvas.style.cursor = "grabbing";
      } else if (event.button === 0) { // Left mouse - Select
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
      this.canvas.style.cursor = "grab";
    };

    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);

    this.canvas.addEventListener("mouseleave", () => {
      this.haveMouse = false;
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
    
    this.onSelect(world.x, world.y);
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

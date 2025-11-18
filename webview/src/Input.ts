import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";

export class Input {
  private scene: Scene;
  private renderer: Renderer;
  private ui: UI;
  private canvas: HTMLCanvasElement;

  private haveMouse = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private ZOOM_SPEED = 0.005;
  private MIN_ZOOM = 0.1;
  private MAX_ZOOM = 500;

  constructor(scene: Scene, renderer: Renderer, ui: UI) {
    this.scene = scene;
    this.renderer = renderer;
    this.ui = ui;
    this.canvas = renderer.canvas;
    
    this.setupListeners();
  }

  private setupListeners() {
    this.canvas.style.touchAction = "none";

    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.scene.state.dragging = true;
      this.scene.state.dragButton = event.button;
      this.scene.state.lastX = event.clientX;
      this.scene.state.lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = "grabbing";
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
        
        if (this.scene.state.dragButton === 0 || this.scene.state.dragButton === 1) {
          const dpr = window.devicePixelRatio || 1;
          this.scene.state.panX += (dx * dpr) / this.scene.state.zoom;
          this.scene.state.panY -= (dy * dpr) / this.scene.state.zoom;
          this.scene.state.needsDraw = true;
        }
      }
      
      this.ui.updateCoordOverlay(this.lastMouseX, this.lastMouseY, this.haveMouse);
    });

    const endDrag = (event: PointerEvent) => {
      if (!this.scene.state.dragging) return;
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

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }
}

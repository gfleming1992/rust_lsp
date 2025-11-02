export class ViewerState {
  panX = 0;
  panY = 0;
  zoom = 1;
  flipX = false;
  flipY = false;

  private dragging = false;
  private dragButton: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;

  needsDraw = true;

  startDrag(button: number, x: number, y: number) {
    this.dragging = true;
    this.dragButton = button;
    this.lastPointerX = x;
    this.lastPointerY = y;
  }

  updateDrag(x: number, y: number): { dx: number; dy: number } | null {
    if (!this.dragging) {
      return null;
    }
    const dx = x - this.lastPointerX;
    const dy = y - this.lastPointerY;
    this.lastPointerX = x;
    this.lastPointerY = y;
    return { dx, dy };
  }

  endDrag() {
    this.dragging = false;
    this.dragButton = null;
  }

  isDragging() {
    return this.dragging;
  }

  getDragButton() {
    return this.dragButton;
  }

  setZoom(value: number) {
    this.zoom = value;
    this.markNeedsDraw();
  }

  setFlipY(value: boolean) {
    this.flipY = value;
    this.markNeedsDraw();
  }

  markNeedsDraw() {
    this.needsDraw = true;
  }

  consumeNeedsDraw() {
    const pending = this.needsDraw;
    this.needsDraw = false;
    return pending;
  }
}

export class Tooltip {
  private element: HTMLDivElement;
  private visible: boolean = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.style.position = 'fixed';
    this.element.style.padding = '4px 8px';
    this.element.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
    this.element.style.color = '#ffffff';
    this.element.style.fontSize = '12px';
    this.element.style.fontFamily = 'monospace';
    this.element.style.borderRadius = '4px';
    this.element.style.border = '1px solid #555';
    this.element.style.pointerEvents = 'none';
    this.element.style.zIndex = '2000';
    this.element.style.display = 'none';
    this.element.style.whiteSpace = 'pre-line'; // Support multi-line text
    this.element.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
    document.body.appendChild(this.element);
  }

  public show(x: number, y: number, text: string) {
    this.element.textContent = text;
    this.positionAndShow(x, y);
  }

  public showHtml(x: number, y: number, html: string) {
    this.element.innerHTML = html;
    this.positionAndShow(x, y);
  }

  private positionAndShow(x: number, y: number) {
    this.element.style.display = 'block';
    
    // Position with offset from cursor
    const offsetX = 15;
    const offsetY = 15;
    
    // Need to get rect after setting display to block
    const rect = this.element.getBoundingClientRect();
    let posX = x + offsetX;
    let posY = y + offsetY;
    
    // Check right edge
    if (posX + rect.width > window.innerWidth) {
      posX = x - rect.width - offsetX;
    }
    
    // Check bottom edge
    if (posY + rect.height > window.innerHeight) {
      posY = y - rect.height - offsetY;
    }
    
    this.element.style.left = `${posX}px`;
    this.element.style.top = `${posY}px`;
    this.visible = true;
  }

  public hide() {
    this.element.style.display = 'none';
    this.visible = false;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public updatePosition(x: number, y: number) {
    if (!this.visible) return;
    
    const offsetX = 15;
    const offsetY = 15;
    
    const rect = this.element.getBoundingClientRect();
    let posX = x + offsetX;
    let posY = y + offsetY;
    
    if (posX + rect.width > window.innerWidth) {
      posX = x - rect.width - offsetX;
    }
    
    if (posY + rect.height > window.innerHeight) {
      posY = y - rect.height - offsetY;
    }
    
    this.element.style.left = `${posX}px`;
    this.element.style.top = `${posY}px`;
  }
}

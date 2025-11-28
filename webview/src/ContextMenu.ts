/**
 * Context menu for PCB viewer - provides right-click options
 */
export class ContextMenu {
  private container: HTMLDivElement;
  private onHighlightNets: (() => void) | null = null;
  private onHighlightComponents: (() => void) | null = null;
  private onShowOnlySelectedNetLayers: (() => void) | null = null;
  private hasSelection: boolean = false;
  private hasComponentSelection: boolean = false;
  private hasNetSelection: boolean = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'context-menu';
    this.container.style.cssText = `
      position: fixed;
      display: none;
      background: #252526;
      border: 1px solid #454545;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 10001;
      min-width: 180px;
      padding: 4px 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
    `;
    
    document.body.appendChild(this.container);
    
    // Hide on click outside
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target as Node)) {
        this.hide();
      }
    });
    
    // Hide on scroll
    document.addEventListener('scroll', () => this.hide(), true);
    
    // Hide on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hide();
      }
    });
  }

  public setOnHighlightNets(callback: () => void) {
    this.onHighlightNets = callback;
  }

  public setOnHighlightComponents(callback: () => void) {
    this.onHighlightComponents = callback;
  }

  public setOnShowOnlySelectedNetLayers(callback: () => void) {
    this.onShowOnlySelectedNetLayers = callback;
  }

  public setHasSelection(hasSelection: boolean) {
    this.hasSelection = hasSelection;
  }

  public setHasComponentSelection(hasComponentSelection: boolean) {
    this.hasComponentSelection = hasComponentSelection;
  }

  public setHasNetSelection(hasNetSelection: boolean) {
    this.hasNetSelection = hasNetSelection;
  }

  private createMenuItem(label: string, enabled: boolean, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.style.cssText = `
      padding: 6px 20px;
      cursor: ${enabled ? 'pointer' : 'default'};
      color: ${enabled ? '#cccccc' : '#666666'};
      white-space: nowrap;
    `;
    
    if (enabled) {
      item.addEventListener('mouseenter', () => {
        item.style.background = '#094771';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('click', () => {
        this.hide();
        onClick();
      });
    }
    
    return item;
  }

  private createSeparator(): HTMLDivElement {
    const sep = document.createElement('div');
    sep.style.cssText = `
      height: 1px;
      background: #454545;
      margin: 4px 0;
    `;
    return sep;
  }

  public show(x: number, y: number) {
    // Clear existing menu items
    this.container.innerHTML = '';
    
    // Add menu items
    const highlightNetsItem = this.createMenuItem(
      'Highlight Selected Net(s)', 
      this.hasSelection && this.onHighlightNets !== null, 
      () => {
        if (this.onHighlightNets) {
          this.onHighlightNets();
        }
      }
    );
    this.container.appendChild(highlightNetsItem);
    
    const highlightComponentsItem = this.createMenuItem(
      'Highlight Selected Component(s)', 
      this.hasComponentSelection && this.onHighlightComponents !== null, 
      () => {
        if (this.onHighlightComponents) {
          this.onHighlightComponents();
        }
      }
    );
    this.container.appendChild(highlightComponentsItem);
    
    // Add separator before layer visibility options
    this.container.appendChild(this.createSeparator());
    
    const showOnlyNetLayersItem = this.createMenuItem(
      'Show only Selected Net Layers', 
      this.hasNetSelection && this.onShowOnlySelectedNetLayers !== null, 
      () => {
        if (this.onShowOnlySelectedNetLayers) {
          this.onShowOnlySelectedNetLayers();
        }
      }
    );
    this.container.appendChild(showOnlyNetLayersItem);
    
    // Position the menu
    this.container.style.display = 'block';
    
    // Adjust position to keep menu in viewport
    const rect = this.container.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let posX = x;
    let posY = y;
    
    if (x + rect.width > viewportWidth) {
      posX = viewportWidth - rect.width - 10;
    }
    if (y + rect.height > viewportHeight) {
      posY = viewportHeight - rect.height - 10;
    }
    
    this.container.style.left = `${posX}px`;
    this.container.style.top = `${posY}px`;
  }

  public hide() {
    this.container.style.display = 'none';
  }
}

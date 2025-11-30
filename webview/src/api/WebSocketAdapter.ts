/**
 * WebSocket API Adapter
 * Communicates with dev-server or standalone backend via WebSocket
 * Used for both dev mode and future browser-based deployment
 */

import { IApiClient, ApiRequest, ApiResponse, ResponseHandler } from './types';

export interface WebSocketAdapterOptions {
  /** WebSocket server URL (default: ws://localhost:5173) */
  url?: string;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay in ms */
  reconnectDelay?: number;
  /** Auto-load file path on connect (dev mode) */
  autoLoadPath?: string;
}

export class WebSocketAdapter implements IApiClient {
  private ws: WebSocket | null = null;
  private handlers: ResponseHandler[] = [];
  private options: Required<WebSocketAdapterOptions>;
  private reconnectTimer: number | null = null;
  private connected = false;

  constructor(options: WebSocketAdapterOptions = {}) {
    this.options = {
      url: options.url || `ws://${window.location.host}`,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 3000,
      autoLoadPath: options.autoLoadPath || '',
    };

    this.connect();
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  send(request: ApiRequest): void {
    if (!this.isConnected()) {
      console.warn('[WebSocketAdapter] Not connected, queuing message');
      return;
    }
    this.ws!.send(JSON.stringify(request));
  }

  onResponse(handler: ResponseHandler): void {
    this.handlers.push(handler);
  }

  notifyReady(): void {
    this.send({ command: 'ready' } as any);
  }

  dispose(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers = [];
    this.connected = false;
  }

  private connect(): void {
    console.log(`[WebSocketAdapter] Connecting to ${this.options.url}`);
    
    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      console.log('[WebSocketAdapter] Connected');
      this.connected = true;
      
      // Auto-load file if configured (dev mode)
      if (this.options.autoLoadPath) {
        this.send({ command: 'Load', filePath: this.options.autoLoadPath });
      }
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event);
    };

    this.ws.onerror = (error) => {
      console.error('[WebSocketAdapter] Error:', error);
    };

    this.ws.onclose = () => {
      console.log('[WebSocketAdapter] Disconnected');
      this.connected = false;
      
      if (this.options.autoReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    
    console.log(`[WebSocketAdapter] Reconnecting in ${this.options.reconnectDelay}ms`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectDelay);
  }

  private handleMessage(event: MessageEvent): void {
    // Handle binary data (tessellation)
    if (event.data instanceof ArrayBuffer) {
      console.log('[WebSocketAdapter] Received binary:', event.data.byteLength, 'bytes');
      this.notifyHandlers({
        command: 'binaryTessellationData',
        binaryPayload: event.data,
      });
      return;
    }

    if (event.data instanceof Blob) {
      console.log('[WebSocketAdapter] Received Blob:', event.data.size, 'bytes');
      event.data.arrayBuffer().then(buffer => {
        this.notifyHandlers({
          command: 'binaryTessellationData',
          binaryPayload: buffer,
        });
      });
      return;
    }

    // Handle JSON messages
    try {
      const data = JSON.parse(event.data);
      
      // Handle reload command (dev server hot reload)
      if (data.type === 'reload') {
        console.log('[WebSocketAdapter] Reload requested');
        window.location.reload();
        return;
      }

      // Forward as API response
      if (data.command) {
        this.notifyHandlers(data as ApiResponse);
      }
    } catch (e) {
      console.error('[WebSocketAdapter] Failed to parse message:', e);
    }
  }

  private notifyHandlers(response: ApiResponse): void {
    for (const handler of this.handlers) {
      try {
        handler(response);
      } catch (e) {
        console.error('[WebSocketAdapter] Handler error:', e);
      }
    }
  }
}

/**
 * Setup debug console overlay for dev mode
 */
export function setupDevConsoleOverlay(): void {
  const debugConsole = document.createElement('div');
  debugConsole.id = 'debug-console';
  debugConsole.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 300px;
    background: rgba(30, 30, 30, 0.95);
    color: #d4d4d4;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 12px;
    overflow-y: auto;
    padding: 8px;
    border-top: 2px solid #007acc;
    z-index: 10000;
    display: flex;
    flex-direction: column;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 4px;
    border-bottom: 1px solid #555;
    margin-bottom: 4px;
    flex-shrink: 0;
  `;
  header.innerHTML = `
    <span style="font-weight: bold; color: #007acc;">[Dev Server Debug Console]</span>
    <button id="clear-console" style="
      background: #007acc;
      color: white;
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 11px;
      border-radius: 3px;
    ">Clear</button>
  `;

  const logContainer = document.createElement('div');
  logContainer.id = 'log-container';
  logContainer.style.cssText = 'flex: 1; overflow-y: auto;';

  debugConsole.appendChild(header);
  debugConsole.appendChild(logContainer);
  document.body.appendChild(debugConsole);

  // Clear button
  const clearButton = document.getElementById('clear-console');
  clearButton?.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });

  // Intercept console methods
  const addLogEntry = (type: string, args: any[]) => {
    const entry = document.createElement('div');
    entry.style.cssText = 'padding: 2px 0; border-bottom: 1px solid #333;';

    const typeColors: Record<string, string> = {
      log: '#d4d4d4',
      error: '#f48771',
      warn: '#dcdcaa',
      info: '#4fc1ff'
    };

    const timestamp = new Date().toISOString().substring(11, 23);
    const color = typeColors[type] || '#d4d4d4';

    const formattedArgs = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    entry.innerHTML = `<span style="color: #858585;">[${timestamp}]</span> <span style="color: ${color};">${formattedArgs}</span>`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  };

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  console.log = (...args: any[]) => {
    addLogEntry('log', args);
    originalLog.apply(console, args);
  };
  console.error = (...args: any[]) => {
    addLogEntry('error', args);
    originalError.apply(console, args);
  };
  console.warn = (...args: any[]) => {
    addLogEntry('warn', args);
    originalWarn.apply(console, args);
  };
  console.info = (...args: any[]) => {
    addLogEntry('info', args);
    originalInfo.apply(console, args);
  };
}

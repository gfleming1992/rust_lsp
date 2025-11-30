/**
 * VS Code Extension API Adapter
 * Communicates with extension.ts via postMessage
 */

import { IApiClient, ApiRequest, ApiResponse, ResponseHandler } from './types';

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    vscode?: VsCodeApi;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export class VsCodeAdapter implements IApiClient {
  private vscode: VsCodeApi | null = null;
  private handlers: ResponseHandler[] = [];
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor() {
    // Acquire VS Code API
    if (window.acquireVsCodeApi) {
      this.vscode = window.acquireVsCodeApi();
      // Make globally available for legacy code
      window.vscode = this.vscode;
    }

    // Listen for messages from extension
    this.messageListener = (event: MessageEvent) => {
      const data = event.data as ApiResponse;
      if (data && typeof data === 'object' && 'command' in data) {
        this.notifyHandlers(data);
      }
    };
    window.addEventListener('message', this.messageListener);
  }

  isConnected(): boolean {
    return this.vscode !== null;
  }

  send(request: ApiRequest): void {
    if (!this.vscode) {
      console.error('[VsCodeAdapter] VS Code API not available');
      return;
    }
    this.vscode.postMessage(request);
  }

  onResponse(handler: ResponseHandler): void {
    this.handlers.push(handler);
  }

  notifyReady(): void {
    this.send({ command: 'ready' } as any);
  }

  dispose(): void {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    this.handlers = [];
  }

  private notifyHandlers(response: ApiResponse): void {
    for (const handler of this.handlers) {
      try {
        handler(response);
      } catch (e) {
        console.error('[VsCodeAdapter] Handler error:', e);
      }
    }
  }
}

/**
 * Setup console forwarding to VS Code extension
 */
export function setupVsCodeConsoleForwarding(vscode: VsCodeApi): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  const serializeArgs = (args: any[]) => args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
    }
    return arg;
  });

  console.log = (...args) => {
    vscode.postMessage({ command: 'console.log', args: serializeArgs(args) });
    originalLog.apply(console, args);
  };
  console.error = (...args) => {
    vscode.postMessage({ command: 'console.error', args: serializeArgs(args) });
    originalError.apply(console, args);
  };
  console.warn = (...args) => {
    vscode.postMessage({ command: 'console.warn', args: serializeArgs(args) });
    originalWarn.apply(console, args);
  };
  console.info = (...args) => {
    vscode.postMessage({ command: 'console.info', args: serializeArgs(args) });
    originalInfo.apply(console, args);
  };
}

/**
 * API module - abstracted backend communication
 * 
 * This module provides a unified interface for communicating with the backend,
 * whether running as a VS Code extension or as a standalone web application.
 */

export * from './types';
export { VsCodeAdapter, setupVsCodeConsoleForwarding } from './VsCodeAdapter';
export { WebSocketAdapter, setupDevConsoleOverlay, type WebSocketAdapterOptions } from './WebSocketAdapter';
export { MessageHandler, type MessageHandlerCallbacks } from './MessageHandler';

import { IApiClient } from './types';
import { VsCodeAdapter } from './VsCodeAdapter';
import { WebSocketAdapter } from './WebSocketAdapter';

/**
 * Detect runtime environment
 */
export function isVsCodeEnvironment(): boolean {
  return typeof window !== 'undefined' && !!window.acquireVsCodeApi;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/**
 * Create the appropriate API client for the current environment
 * @param mode - 'vscode' or 'websocket' 
 * @param vscode - Optional VS Code API instance (if already acquired)
 */
export function createApiClient(mode?: 'vscode' | 'websocket', vscode?: VsCodeApi | null): IApiClient {
  // Auto-detect if mode not specified
  const resolvedMode = mode ?? (isVsCodeEnvironment() ? 'vscode' : 'websocket');
  
  if (resolvedMode === 'vscode') {
    console.log('[API] Creating VS Code adapter');
    return new VsCodeAdapter(vscode);
  } else {
    console.log('[API] Creating WebSocket adapter');
    return new WebSocketAdapter();
  }
}

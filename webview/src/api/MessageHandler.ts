/**
 * Message Handler - processes API responses from the backend
 * 
 * This centralizes all response handling logic that was previously
 * scattered across main.ts's message event listener.
 */

import { 
  ApiResponse, 
  IApiClient, 
  BinaryTessellationDataResponse,
  TessellationDataResponse,
  SelectionResultResponse,
  HighlightNetsResultResponse,
  HighlightComponentsResultResponse,
  DrcRegionsResultResponse,
  MemoryResultResponse,
  NetAtPointResultResponse,
  SaveCompleteResponse,
  SaveErrorResponse,
  ErrorResponse
} from './types';
import { LayerJSON, ObjectRange, DrcRegion } from '../types';

export interface MessageHandlerCallbacks {
  // Layer/tessellation callbacks
  onLayerData?: (layer: LayerJSON) => void;
  onLayerCount?: (count: number) => void;
  onBinaryData?: (buffer: ArrayBuffer) => Promise<LayerJSON>;
  
  // Selection callbacks
  onSelectionResult?: (ranges: ObjectRange[], isBoxSelect: boolean, isCtrlSelect: boolean) => void;
  onHighlightNetsResult?: (netNames: string[], objects: ObjectRange[]) => void;
  onHighlightComponentsResult?: (componentRefs: string[], objects: ObjectRange[]) => void;
  
  // DRC callbacks
  onDrcResult?: (regions: DrcRegion[], elapsedMs: number, error?: string) => void;
  
  // Info callbacks
  onMemoryResult?: (memoryBytes: number) => void;
  onNetAtPoint?: (netName: string | undefined, componentRef: string | undefined, pinRef: string | undefined, x: number, y: number) => void;
  
  // Save callbacks
  onSaveComplete?: (filePath: string) => void;
  onSaveError?: (error: string) => void;
  
  // Error callback
  onError?: (message: string) => void;
}

export class MessageHandler {
  private callbacks: MessageHandlerCallbacks;
  private pendingLayers: LayerJSON[] = [];
  private batchTimeout: number | null = null;
  private batchDelayMs = 16; // ~60fps batching
  
  // Selection state (passed from main)
  private isBoxSelect = false;
  private isCtrlSelect = false;

  constructor(callbacks: MessageHandlerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Register with an API client
   */
  register(client: IApiClient): void {
    client.onResponse((response) => this.handleResponse(response));
  }

  /**
   * Set selection mode flags (called from Input handler)
   */
  setSelectionMode(isBoxSelect: boolean, isCtrlSelect: boolean): void {
    this.isBoxSelect = isBoxSelect;
    this.isCtrlSelect = isCtrlSelect;
  }

  /**
   * Handle an incoming response
   */
  async handleResponse(response: ApiResponse): Promise<void> {
    const startTime = performance.now();

    switch (response.command) {
      case 'layerCount':
        this.callbacks.onLayerCount?.(response.count);
        break;

      case 'binaryTessellationData':
        await this.handleBinaryTessellation(response);
        break;

      case 'tessellationData':
        this.handleJsonTessellation(response);
        break;

      case 'selectionResult':
        this.handleSelectionResult(response);
        break;

      case 'highlightNetsResult':
        this.handleHighlightNetsResult(response);
        break;

      case 'highlightComponentsResult':
        this.handleHighlightComponentsResult(response);
        break;

      case 'drcRegionsResult':
        this.handleDrcResult(response);
        break;

      case 'memoryResult':
        this.callbacks.onMemoryResult?.(response.memoryBytes);
        break;

      case 'netAtPointResult':
        this.handleNetAtPointResult(response);
        break;

      case 'saveComplete':
        this.handleSaveComplete(response);
        break;

      case 'saveError':
        this.handleSaveError(response);
        break;

      case 'error':
        this.handleError(response);
        break;

      default:
        // Ignore unknown commands (like layerList which is handled elsewhere)
        break;
    }

    const elapsed = performance.now() - startTime;
    if (elapsed > 10) {
      console.log(`[MessageHandler] ${response.command} took ${elapsed.toFixed(1)}ms`);
    }
  }

  private async handleBinaryTessellation(response: BinaryTessellationDataResponse): Promise<void> {
    const payload = response.binaryPayload;
    let arrayBuffer: ArrayBuffer;

    // Convert payload to ArrayBuffer
    if (payload instanceof ArrayBuffer) {
      arrayBuffer = payload;
    } else if (payload instanceof Uint8Array) {
      if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
        arrayBuffer = payload.buffer as ArrayBuffer;
      } else {
        arrayBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
      }
    } else if (typeof payload === 'string') {
      // Base64 string (legacy fallback)
      const binaryString = atob(payload);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      arrayBuffer = bytes.buffer;
    } else if (typeof payload === 'object' && payload !== null) {
      // VS Code may serialize Uint8Array as plain object
      const obj = payload as Record<number, number>;
      const keys = Object.keys(obj);
      const bytes = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        bytes[i] = obj[i];
      }
      arrayBuffer = bytes.buffer;
    } else {
      console.error(`[MessageHandler] Unexpected binaryPayload type: ${typeof payload}`);
      return;
    }

    // Parse binary data
    if (this.callbacks.onBinaryData) {
      try {
        const layerJson = await this.callbacks.onBinaryData(arrayBuffer);
        this.queueLayer(layerJson);
      } catch (error) {
        console.error('[MessageHandler] Binary parsing failed:', error);
      }
    }
  }

  private handleJsonTessellation(response: TessellationDataResponse): void {
    console.log(`[MessageHandler] Received JSON layer: ${response.payload.layerId}`);
    this.queueLayer(response.payload);
  }

  private queueLayer(layer: LayerJSON): void {
    this.pendingLayers.push(layer);

    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
    }
    this.batchTimeout = window.setTimeout(() => this.processPendingLayers(), this.batchDelayMs);
  }

  private processPendingLayers(): void {
    this.batchTimeout = null;
    const layers = this.pendingLayers;
    this.pendingLayers = [];

    for (const layer of layers) {
      this.callbacks.onLayerData?.(layer);
    }
  }

  private handleSelectionResult(response: SelectionResultResponse): void {
    this.callbacks.onSelectionResult?.(response.ranges, this.isBoxSelect, this.isCtrlSelect);
  }

  private handleHighlightNetsResult(response: HighlightNetsResultResponse): void {
    console.log(`[MessageHandler] Highlight nets: ${response.netNames.length} nets, ${response.objects.length} objects`);
    this.callbacks.onHighlightNetsResult?.(response.netNames, response.objects);
  }

  private handleHighlightComponentsResult(response: HighlightComponentsResultResponse): void {
    console.log(`[MessageHandler] Highlight components: ${response.componentRefs.length} refs, ${response.objects.length} objects`);
    this.callbacks.onHighlightComponentsResult?.(response.componentRefs, response.objects);
  }

  private handleDrcResult(response: DrcRegionsResultResponse): void {
    console.log(`[MessageHandler] DRC result: ${response.regions.length} regions`);
    this.callbacks.onDrcResult?.(response.regions, response.elapsedMs || 0, response.error);
  }

  private handleNetAtPointResult(response: NetAtPointResultResponse): void {
    this.callbacks.onNetAtPoint?.(response.netName, response.componentRef, response.pinRef, response.x, response.y);
  }

  private handleSaveComplete(response: SaveCompleteResponse): void {
    console.log(`[MessageHandler] Save complete: ${response.filePath}`);
    this.callbacks.onSaveComplete?.(response.filePath);

    // Update save button
    const saveBtn = document.getElementById('savePcbBtn') as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save';
    }
  }

  private handleSaveError(response: SaveErrorResponse): void {
    console.error(`[MessageHandler] Save error: ${response.error}`);
    this.callbacks.onSaveError?.(response.error);

    // Update save button
    const saveBtn = document.getElementById('savePcbBtn') as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save';
    }
  }

  private handleError(response: ErrorResponse): void {
    console.error(`[MessageHandler] Error: ${response.message}`);
    this.callbacks.onError?.(response.message);
  }
}

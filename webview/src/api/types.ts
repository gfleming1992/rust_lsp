/**
 * Shared API types for communication between webview and backend
 * Used by both VS Code extension and dev server/browser modes
 */

import { LayerJSON, ObjectRange, DrcRegion } from '../types';

// ============================================================================
// Request Commands (Webview -> Backend)
// ============================================================================

export interface LoadRequest {
  command: 'Load';
  filePath?: string;
}

export interface GetLayersRequest {
  command: 'GetLayers';
}

export interface GetTessellationRequest {
  command: 'GetTessellation';
  layerId: string;
  useBinary?: boolean;
}

export interface SelectRequest {
  command: 'Select';
  x: number;
  y: number;
}

export interface BoxSelectRequest {
  command: 'BoxSelect';
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface UpdateLayerColorRequest {
  command: 'UpdateLayerColor';
  layerId: string;
  color: [number, number, number, number];
}

export interface SetLayerVisibilityRequest {
  command: 'SetLayerVisibility';
  layerId: string;
  visible: boolean;
}

export interface SaveRequest {
  command: 'Save';
  filePath?: string;
}

export interface DeleteRequest {
  command: 'Delete';
  objectIds: number[];
}

export interface UndoRequest {
  command: 'Undo';
}

export interface RedoRequest {
  command: 'Redo';
}

export interface HighlightSelectedNetsRequest {
  command: 'HighlightSelectedNets';
  objectIds: number[];
}

export interface HighlightSelectedComponentsRequest {
  command: 'HighlightSelectedComponents';
  objectIds: number[];
}

export interface QueryNetAtPointRequest {
  command: 'QueryNetAtPoint';
  x: number;
  y: number;
  clientX?: number;
  clientY?: number;
}

export interface GetMemoryRequest {
  command: 'GetMemory';
}

export interface RunDRCWithRegionsRequest {
  command: 'RunDRCWithRegions';
  clearance_mm?: number;
  force_full?: boolean;
}

export type ApiRequest =
  | LoadRequest
  | GetLayersRequest
  | GetTessellationRequest
  | SelectRequest
  | BoxSelectRequest
  | UpdateLayerColorRequest
  | SetLayerVisibilityRequest
  | SaveRequest
  | DeleteRequest
  | UndoRequest
  | RedoRequest
  | HighlightSelectedNetsRequest
  | HighlightSelectedComponentsRequest
  | QueryNetAtPointRequest
  | GetMemoryRequest
  | RunDRCWithRegionsRequest;

// ============================================================================
// Response Events (Backend -> Webview)
// ============================================================================

export interface LayerListResponse {
  command: 'layerList';
  layers: string[];
}

export interface LayerCountResponse {
  command: 'layerCount';
  count: number;
}

export interface TessellationDataResponse {
  command: 'tessellationData';
  payload: LayerJSON;
}

export interface BinaryTessellationDataResponse {
  command: 'binaryTessellationData';
  binaryPayload: ArrayBuffer | Uint8Array | string;
}

export interface SelectionResultResponse {
  command: 'selectionResult';
  ranges: ObjectRange[];
}

export interface HighlightNetsResultResponse {
  command: 'highlightNetsResult';
  netNames: string[];
  objects: ObjectRange[];
}

export interface HighlightComponentsResultResponse {
  command: 'highlightComponentsResult';
  componentRefs: string[];
  objects: ObjectRange[];
}

export interface NetAtPointResultResponse {
  command: 'netAtPointResult';
  netName?: string;
  componentRef?: string;
  pinRef?: string;
  x: number;
  y: number;
}

export interface MemoryResultResponse {
  command: 'memoryResult';
  memoryBytes: number;
}

export interface DrcRegionsResultResponse {
  command: 'drcRegionsResult';
  regions: DrcRegion[];
  elapsedMs?: number;
  error?: string;
}

export interface SaveCompleteResponse {
  command: 'saveComplete';
  filePath: string;
}

export interface SaveErrorResponse {
  command: 'saveError';
  error: string;
}

export interface ErrorResponse {
  command: 'error';
  message: string;
}

export type ApiResponse =
  | LayerListResponse
  | LayerCountResponse
  | TessellationDataResponse
  | BinaryTessellationDataResponse
  | SelectionResultResponse
  | HighlightNetsResultResponse
  | HighlightComponentsResultResponse
  | NetAtPointResultResponse
  | MemoryResultResponse
  | DrcRegionsResultResponse
  | SaveCompleteResponse
  | SaveErrorResponse
  | ErrorResponse;

// ============================================================================
// API Client Interface
// ============================================================================

export type ResponseHandler = (response: ApiResponse) => void;

/**
 * Abstract interface for backend communication
 * Implementations: VsCodeAdapter, WebSocketAdapter
 */
export interface IApiClient {
  /** Send a request to the backend */
  send(request: ApiRequest): void;
  
  /** Register a handler for responses */
  onResponse(handler: ResponseHandler): void;
  
  /** Notify backend that webview is ready */
  notifyReady(): void;
  
  /** Check if client is connected/ready */
  isConnected(): boolean;
  
  /** Cleanup resources */
  dispose(): void;
}

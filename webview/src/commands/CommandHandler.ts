/**
 * CommandHandler - handles incoming commands from the backend
 * 
 * This centralizes all the command processing logic that was previously
 * in the main.ts message event listener.
 */

import { Scene } from "../Scene";
import { Renderer } from "../Renderer";
import { UI } from "../UI";
import { Input } from "../Input";
import { LayerJSON, ObjectRange, DrcRegion } from "../types";
import { BinaryParserPool } from "../parsing/BinaryParserPool";
import { DebugOverlay } from "../debug/DebugOverlay";
import { IApiClient } from "../api/types";

import {
    handleSelectionResult,
    handleHighlightNetsResult,
    handleHighlightComponentsResult,
    handleNetAtPointResult,
    handleDeleteRelatedObjects,
} from "./SelectionHandlers";

import {
    performDelete as doDelete,
    performUndo as doUndo,
    performRedo as doRedo,
    DeleteUndoRedoDeps
} from "./DeleteUndoRedo";

export interface SelectionState {
    selectedObjects: ObjectRange[];
    deletedObjectIds: Set<number>;
    isBoxSelect: boolean;
    isCtrlSelect: boolean;
    lastNetHighlightAllObjects: ObjectRange[];
}

export interface UndoRedoState {
    undoStack: ObjectRange[][];
    redoStack: ObjectRange[][];
}

export interface CommandHandlerDeps {
    scene: Scene;
    renderer: Renderer;
    ui: UI;
    input: Input;
    debugOverlay: DebugOverlay | null;
    workerPool: BinaryParserPool;
    api: IApiClient;
    selectionState: SelectionState;
    undoRedoState: UndoRedoState;
    onInitialLoadComplete?: () => void;
}

export class CommandHandler {
    private deps: CommandHandlerDeps;
    private pendingLayers: LayerJSON[] = [];
    private batchTimeout: number | null = null;
    private initialLoadComplete = false;
    
    constructor(deps: CommandHandlerDeps) {
        this.deps = deps;
    }
    
    /**
     * Process an incoming message from the backend
     */
    async handleMessage(data: Record<string, unknown>): Promise<void> {
        const command = data.command as string;
        
        switch (command) {
            case 'saveComplete':
                this.handleSaveComplete(data);
                break;
            case 'saveError':
                this.handleSaveError(data);
                break;
            case 'binaryTessellationData':
                await this.handleBinaryTessellation(data);
                break;
            case 'tessellationData':
                this.handleJsonTessellation(data);
                break;
            case 'error':
                console.error(`Extension error: ${data.message}`);
                break;
            case 'selectionResult':
                handleSelectionResult(this.getSelectionDeps(), data);
                break;
            case 'highlightNetsResult':
                handleHighlightNetsResult(this.getSelectionDeps(), data);
                break;
            case 'highlightComponentsResult':
                handleHighlightComponentsResult(this.getSelectionDeps(), data);
                break;
            case 'netAtPointResult':
                handleNetAtPointResult(this.getSelectionDeps(), data);
                break;
            case 'deleteRelatedObjects':
                handleDeleteRelatedObjects(this.getSelectionDeps(), data);
                break;
            case 'memoryResult':
                this.handleMemoryResult(data);
                break;
            case 'drcRegionsResult':
                this.handleDrcRegionsResult(data);
                break;
            default:
                // Unknown command - ignore silently
                break;
        }
    }
    
    private getSelectionDeps() {
        return {
            scene: this.deps.scene,
            input: this.deps.input,
            selectionState: this.deps.selectionState,
            undoRedoState: this.deps.undoRedoState
        };
    }
    
    private getDeleteUndoRedoDeps(): DeleteUndoRedoDeps {
        return {
            scene: this.deps.scene,
            api: this.deps.api,
            selectionState: this.deps.selectionState,
            undoRedoState: this.deps.undoRedoState
        };
    }
    
    private handleSaveComplete(data: Record<string, unknown>): void {
        const filePath = data.filePath as string | undefined;
        console.log(`[SAVE] Save completed: ${filePath || 'unknown path'}`);
        
        const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = "💾 Save";
        }
    }
    
    private handleSaveError(data: Record<string, unknown>): void {
        const error = data.error as string | undefined;
        console.error(`[SAVE] Save failed: ${error || 'unknown error'}`);
        
        const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = "💾 Save";
        }
    }
    
    private async handleBinaryTessellation(data: Record<string, unknown>): Promise<void> {
        const payload = data.binaryPayload;
        if (!payload) return;
        
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
            console.error(`[MSG] Unexpected binaryPayload type: ${typeof payload}`);
            return;
        }
        
        try {
            const layerJson = await this.deps.workerPool.parse(arrayBuffer);
            this.pendingLayers.push(layerJson);
            this.scheduleBatchProcessing();
        } catch (error) {
            console.error(`[MSG] Binary parsing failed:`, error);
        }
    }
    
    private handleJsonTessellation(data: Record<string, unknown>): void {
        const layerJson = data.payload as LayerJSON;
        if (!layerJson) return;
        
        console.log(`[MSG] Received JSON ${layerJson.layerId}`);
        this.pendingLayers.push(layerJson);
        this.scheduleBatchProcessing();
    }
    
    private scheduleBatchProcessing(): void {
        if (this.batchTimeout !== null) {
            clearTimeout(this.batchTimeout);
        }
        // Process immediately - no artificial delay
        this.batchTimeout = window.setTimeout(() => this.processPendingLayers(), 0);
    }
    
    private processPendingLayers(): void {
        if (this.pendingLayers.length === 0) return;
        
        const batchStart = performance.now();
        console.log(`[BATCH] Processing ${this.pendingLayers.length} layers at once...`);
        
        for (const layerJson of this.pendingLayers) {
            this.deps.scene.loadLayerData(layerJson);
        }
        
        this.deps.ui.refreshLayerLegend();
        this.deps.renderer.finishLoading();
        
        if (this.deps.debugOverlay) {
            this.deps.debugOverlay.extractPointsFromLayers();
        }
        
        const batchEnd = performance.now();
        console.log(`[BATCH] Loaded ${this.pendingLayers.length} layers in ${(batchEnd - batchStart).toFixed(1)}ms`);
        
        this.pendingLayers = [];
        this.batchTimeout = null;
        
        if (!this.initialLoadComplete) {
            this.initialLoadComplete = true;
            this.deps.onInitialLoadComplete?.();
        }
    }
    
    private handleMemoryResult(data: Record<string, unknown>): void {
        const memoryBytes = data.memoryBytes as number | null;
        this.deps.ui.setRustMemory(memoryBytes);
    }
    
    private handleDrcRegionsResult(data: Record<string, unknown>): void {
        const regions = data.regions as DrcRegion[];
        const elapsedMs = data.elapsedMs as number;
        console.log(`[DRC] Received ${regions.length} DRC regions in ${elapsedMs.toFixed(2)}ms`);
        
        this.deps.scene.loadDrcRegions(regions);
        this.deps.ui.populateDrcList(regions);
        this.deps.ui.updateDrcPanel(regions.length, 0, null, false);
    }
    
    /**
     * Perform delete operation on selected objects
     */
    performDelete(objects: ObjectRange[], source: string): void {
        doDelete(this.getDeleteUndoRedoDeps(), objects, source);
    }
    
    /**
     * Perform undo operation
     */
    performUndo(): void {
        doUndo(this.getDeleteUndoRedoDeps());
    }
    
    /**
     * Perform redo operation
     */
    performRedo(): void {
        doRedo(this.getDeleteUndoRedoDeps());
    }
}

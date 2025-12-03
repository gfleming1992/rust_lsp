import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { LayerJSON, ObjectRange, DrcRegion } from "./types";
import { BinaryParserPool } from "./BinaryParserPool";
import { DebugOverlay } from "./DebugOverlay";

export interface MessageHandlerContext {
  scene: Scene;
  renderer: Renderer;
  ui: UI;
  input: Input;
  debugOverlay: DebugOverlay | null;
  workerPool: BinaryParserPool;
  isVSCodeWebview: boolean;
  vscode: any;
  
  // Mutable state refs (updated by message handlers)
  selectedObjects: ObjectRange[];
  deletedObjectIds: Set<number>;
  isBoxSelect: boolean;
  isCtrlSelect: boolean;
  lastNetHighlightAllObjects: ObjectRange[];
  lastSelectX: number;
  lastSelectY: number;
  
  // Undo/redo stacks
  undoStack: UndoAction[];
  redoStack: UndoAction[];
}

export type UndoAction = 
  | { type: 'delete'; objects: ObjectRange[] }
  | { type: 'move'; objects: ObjectRange[]; deltaX: number; deltaY: number };

/** Sets up the window message event listener for extension/dev server communication */
export function setupMessageHandler(ctx: MessageHandlerContext) {
  const { scene, renderer, ui, input, debugOverlay, workerPool, isVSCodeWebview, vscode } = ctx;
  
  // Batch layer loading state
  let pendingLayers: LayerJSON[] = [];
  let batchTimeout: number | null = null;
  let initialLoadComplete = false;
  let drcAutoTriggered = false;
  const BATCH_DELAY_MS = 0;

  function processPendingLayers() {
    if (pendingLayers.length === 0) return;
    
    const batchStart = performance.now();
    console.log(`[BATCH] Processing ${pendingLayers.length} layers at once...`);
    
    for (const layerJson of pendingLayers) {
      scene.loadLayerData(layerJson);
    }
    
    ui.refreshLayerLegend();
    renderer.finishLoading();
    
    if (debugOverlay) {
      debugOverlay.extractPointsFromLayers();
    }
    
    const batchEnd = performance.now();
    console.log(`[BATCH] Loaded ${pendingLayers.length} layers in ${(batchEnd - batchStart).toFixed(1)}ms`);
    
    pendingLayers = [];
    batchTimeout = null;
    
    // Auto-trigger DRC after initial load
    if (!initialLoadComplete) {
      initialLoadComplete = true;
      setTimeout(() => {
        if (!drcAutoTriggered && isVSCodeWebview && vscode) {
          drcAutoTriggered = true;
          console.log('[DRC] Auto-triggering DRC after initial load...');
          ui.showDrcProgress();
          vscode.postMessage({ command: 'RunDRCWithRegions', clearance_mm: 0.15 });
        }
      }, 500);
    }
  }

  window.addEventListener("message", async (event) => {
    const msgStart = performance.now();
    const data = event.data as Record<string, unknown>;
    
    // Save completion/error
    if (data.command === "saveComplete") {
      console.log(`[SAVE] Save completed: ${data.filePath || 'unknown path'}`);
      const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Save"; }
      return;
    }
    
    if (data.command === "saveError") {
      console.error(`[SAVE] Save failed: ${data.error || 'unknown error'}`);
      const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Save"; }
      return;
    }
    
    // Binary tessellation data
    if (data.command === "binaryTessellationData" && data.binaryPayload) {
      const arrayBuffer = convertPayloadToArrayBuffer(data.binaryPayload);
      if (!arrayBuffer) return;
      
      try {
        const layerJson = await workerPool.parse(arrayBuffer);
        pendingLayers.push(layerJson);
        if (batchTimeout !== null) clearTimeout(batchTimeout);
        batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      } catch (error) {
        console.error(`[MSG] Binary parsing failed:`, error);
      }
      return;
    }
    
    // JSON tessellation data (fallback)
    if (data.command === "tessellationData" && data.payload) {
      const layerJson = data.payload as LayerJSON;
      console.log(`[MSG] Received JSON ${layerJson.layerId} (parsed in ${(performance.now() - msgStart).toFixed(1)}ms)`);
      pendingLayers.push(layerJson);
      if (batchTimeout !== null) clearTimeout(batchTimeout);
      batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      return;
    }
    
    if (data.command === "error") {
      console.error(`Extension error: ${data.message}`);
      return;
    }
    
    // Selection result
    if (data.command === "selectionResult" && data.ranges) {
      handleSelectionResult(ctx, data.ranges as ObjectRange[]);
      return;
    }
    
    // Highlight nets result
    if (data.command === "highlightNetsResult" && data.objects) {
      handleHighlightNetsResult(ctx, data.objects as ObjectRange[], data.netNames as string[]);
      return;
    }
    
    // Highlight components result
    if (data.command === "highlightComponentsResult" && data.objects) {
      handleHighlightComponentsResult(ctx, data.objects as ObjectRange[], data.componentRefs as string[]);
      return;
    }
    
    // Net at point result (tooltip)
    if (data.command === "netAtPointResult") {
      handleNetAtPointResult(ctx, data);
      return;
    }
    
    // Delete related objects
    if (data.command === "deleteRelatedObjects" && data.objects) {
      handleDeleteRelatedObjects(ctx, data.objects as ObjectRange[]);
      return;
    }
    
    // Memory result
    if (data.command === "memoryResult") {
      ui.setRustMemory(data.memoryBytes as number | null);
      return;
    }
    
    // DRC regions result
    if (data.command === "drcRegionsResult") {
      const regions = data.regions as DrcRegion[];
      console.log(`[DRC] Received ${regions.length} DRC regions in ${(data.elapsedMs as number).toFixed(2)}ms`);
      scene.loadDrcRegions(regions);
      ui.populateDrcList(regions);
      ui.updateDrcPanel(regions.length, 0, null, false);
      return;
    }
  });
}

// ==================== Helper Functions ====================

function convertPayloadToArrayBuffer(payload: any): ArrayBuffer | null {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
      return payload.buffer as ArrayBuffer;
    }
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  }
  if (typeof payload === 'string') {
    const binaryString = atob(payload);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<number, number>;
    const keys = Object.keys(obj);
    const bytes = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      bytes[i] = obj[i];
    }
    return bytes.buffer;
  }
  console.error(`[MSG] Unexpected binaryPayload type: ${typeof payload}`);
  return null;
}

function handleSelectionResult(ctx: MessageHandlerContext, ranges: ObjectRange[]) {
  const { scene, input, deletedObjectIds, isBoxSelect, isCtrlSelect, lastSelectX, lastSelectY } = ctx;
  
  // Filter out deleted objects and objects from invisible layers
  const visibleRanges = ranges.filter(range => {
    const isDeleted = deletedObjectIds.has(range.id);
    const isLayerVisible = scene.layerVisible.get(range.layer_id) !== false;
    return !isDeleted && isLayerVisible;
  });
  
  if (visibleRanges.length > 0) {
    // Sort by layer order (topmost first)
    visibleRanges.sort((a, b) => {
      const aIndex = scene.layerOrder.indexOf(a.layer_id);
      const bIndex = scene.layerOrder.indexOf(b.layer_id);
      return bIndex - aIndex;
    });
    
    if (isBoxSelect) {
      ctx.selectedObjects = visibleRanges;
      scene.highlightMultipleObjects(visibleRanges);
      input.hideTooltip();
    } else if (isCtrlSelect) {
      const newObj = visibleRanges[0];
      const existingIndex = ctx.selectedObjects.findIndex(obj => obj.id === newObj.id);
      
      if (existingIndex >= 0) {
        ctx.selectedObjects.splice(existingIndex, 1);
      } else {
        ctx.selectedObjects.push(newObj);
      }
      
      if (ctx.selectedObjects.length > 0) {
        scene.highlightMultipleObjects(ctx.selectedObjects);
      } else {
        scene.clearHighlightObject();
      }
      input.hideTooltip();
    } else {
      const selected = visibleRanges[0];
      const wasAlreadySelected = ctx.selectedObjects.some(obj => obj.id === selected.id);
      
      if (wasAlreadySelected && ctx.selectedObjects.length > 0) {
        console.log(`[Select] Clicked on already-selected object ${selected.id}, starting move mode`);
        input.startMoveMode(lastSelectX, lastSelectY);
      } else {
        ctx.selectedObjects = [selected];
        scene.highlightObject(selected);
      }
    }
    
    ctx.lastNetHighlightAllObjects = [];
    input.setHasSelection(ctx.selectedObjects.length > 0);
    input.setHasComponentSelection(ctx.selectedObjects.some(obj => obj.component_ref));
    input.setHasNetSelection(ctx.selectedObjects.some(obj => obj.net_name && obj.net_name !== 'No Net'));
  } else if (!isCtrlSelect) {
    ctx.selectedObjects = [];
    ctx.lastNetHighlightAllObjects = [];
    scene.clearHighlightObject();
    input.setHasSelection(false);
    input.setHasComponentSelection(false);
    input.setHasNetSelection(false);
    input.hideTooltip();
  }
}

function handleHighlightNetsResult(ctx: MessageHandlerContext, objects: ObjectRange[], netNames: string[]) {
  const { scene, input, deletedObjectIds } = ctx;
  
  console.log(`[HighlightNets] Received ${objects.length} objects with nets: ${netNames.join(', ')}`);
  
  ctx.lastNetHighlightAllObjects = objects.filter(obj => !deletedObjectIds.has(obj.id));
  
  const visibleObjects = objects.filter(obj => {
    const isDeleted = deletedObjectIds.has(obj.id);
    const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
    return !isDeleted && isLayerVisible;
  });
  
  if (visibleObjects.length > 0) {
    ctx.selectedObjects = visibleObjects;
    scene.highlightMultipleObjects(visibleObjects);
    console.log(`[HighlightNets] Highlighted ${visibleObjects.length} objects for nets: ${netNames.join(', ')}`);
    input.setHasSelection(true);
    input.setHasComponentSelection(visibleObjects.some(obj => obj.component_ref));
    input.setHasNetSelection(true);
  }
}

function handleHighlightComponentsResult(ctx: MessageHandlerContext, objects: ObjectRange[], componentRefs: string[]) {
  const { scene, input, deletedObjectIds } = ctx;
  
  console.log(`[HighlightComponents] Received ${objects.length} objects with components: ${componentRefs.join(', ')}`);
  
  const visibleObjects = objects.filter(obj => {
    const isDeleted = deletedObjectIds.has(obj.id);
    const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
    return !isDeleted && isLayerVisible;
  });
  
  if (visibleObjects.length > 0) {
    ctx.selectedObjects = visibleObjects;
    scene.highlightMultipleObjects(visibleObjects);
    console.log(`[HighlightComponents] Highlighted ${visibleObjects.length} objects for components: ${componentRefs.join(', ')}`);
    input.setHasSelection(true);
    input.setHasComponentSelection(visibleObjects.some(obj => obj.component_ref));
    input.setHasNetSelection(visibleObjects.some(obj => obj.net_name && obj.net_name !== 'No Net'));
  }
}

function handleNetAtPointResult(ctx: MessageHandlerContext, data: Record<string, unknown>) {
  const netName = data.netName as string | null;
  const componentRef = data.componentRef as string | null;
  const pinRef = data.pinRef as string | null;
  const clientX = data.x as number;
  const clientY = data.y as number;
  
  if (netName && netName.trim() !== "") {
    const tooltipInfo: { net?: string; component?: string; pin?: string } = { net: netName };
    if (componentRef) tooltipInfo.component = componentRef.replace(/^CMP:/, '');
    if (pinRef) tooltipInfo.pin = pinRef.replace(/^PIN:/, '');
    ctx.input.showSelectionTooltip(tooltipInfo, clientX, clientY);
  }
}

function handleDeleteRelatedObjects(ctx: MessageHandlerContext, relatedObjects: ObjectRange[]) {
  const { scene, deletedObjectIds, undoStack } = ctx;
  
  console.log(`[Delete] Hiding ${relatedObjects.length} related objects (vias across layers)`);
  
  for (const obj of relatedObjects) {
    scene.hideObject(obj);
    deletedObjectIds.add(obj.id);
  }
  
  // Add to last undo entry
  if (undoStack.length > 0) {
    const lastAction = undoStack[undoStack.length - 1];
    if (lastAction.type === 'delete') {
      for (const obj of relatedObjects) {
        if (!lastAction.objects.some(existing => existing.id === obj.id)) {
          lastAction.objects.push(obj);
        }
      }
      console.log(`[Delete] Updated undo batch to ${lastAction.objects.length} total objects`);
    }
  }
  
  scene.state.needsDraw = true;
}

import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { LayerJSON, ObjectRange, DrcRegion } from "./types";
import { BinaryParserPool } from "./parsing/BinaryParserPool";
import { DebugOverlay } from "./debug/DebugOverlay";
import { BoundsDebugOverlay } from "./debug/BoundsDebugOverlay";

/** Transformed instance from LSP TransformPreview */
interface TransformedInstance {
  object_id: number;
  layer_id: string;
  /** The original layer where GPU buffer data lives (for buffer updates during preview) */
  original_layer_id: string;
  x: number;
  y: number;
  packed_rot_vis: number;
  shape_idx: number;
  instance_idx: number;
}

export interface MessageHandlerContext {
  scene: Scene;
  renderer: Renderer;
  ui: UI;
  input: Input;
  debugOverlay: DebugOverlay | null;
  boundsDebugOverlay: BoundsDebugOverlay | null;
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
  preFlipRenderLayerById: Map<number, string>;
  
  // Undo/redo stacks
  undoStack: UndoAction[];
  redoStack: UndoAction[];
}

export type UndoAction = 
  | { type: 'delete'; objects: ObjectRange[] }
  | { type: 'move'; objects: ObjectRange[]; deltaX: number; deltaY: number }
  | { type: 'rotate'; objects: ObjectRange[]; rotationDelta: number; componentCenter: { x: number; y: number }; perObjectOffsets: { id: number; dx: number; dy: number }[] }
  | { type: 'move_rotate'; objects: ObjectRange[]; deltaX: number; deltaY: number; rotationDelta: number; componentCenter: { x: number; y: number }; perObjectOffsets: { id: number; dx: number; dy: number }[] }
  | { type: 'transform'; objectIds: number[]; deltaX: number; deltaY: number; rotateDegrees: number; flipped: boolean };

/** Active transform session tracking for undo support */
export interface TransformSession {
  objectIds: number[];
  startCenter: { x: number; y: number };
  lastDeltaX: number;
  lastDeltaY: number;
  lastRotateDegrees: number;
  flipped: boolean;
}

/** Global transform session - set by main.ts when StartTransform is sent */
let activeTransformSession: TransformSession | null = null;

export function setActiveTransformSession(session: TransformSession | null) {
  activeTransformSession = session;
}

export function getActiveTransformSession(): TransformSession | null {
  return activeTransformSession;
}

export function updateTransformSession(deltaX: number, deltaY: number, rotateDegrees?: number, flip?: boolean) {
  if (activeTransformSession) {
    activeTransformSession.lastDeltaX = deltaX;
    activeTransformSession.lastDeltaY = deltaY;
    if (rotateDegrees !== undefined) {
      activeTransformSession.lastRotateDegrees = rotateDegrees;
    }
    if (flip) {
      activeTransformSession.flipped = !activeTransformSession.flipped;
    }
  }
}

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
          vscode.postMessage({ command: 'RunDRCWithRegions' });
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
    
    // Object bounds result - for debug overlay
    if (data.command === "objectBoundsResult" && data.objects) {
      const objects = data.objects as Array<{ id: number; bounds: [number, number, number, number]; layer_id: string; component_ref: string | null; pin_ref: string | null }>;
      console.log(`[BoundsDebug] Received ${objects.length} object bounds from LSP`);
      if (ctx.boundsDebugOverlay) {
        // Convert to ObjectRange-like format for the overlay
        const ranges: ObjectRange[] = objects.map(obj => ({
          id: obj.id,
          bounds: obj.bounds,
          layer_id: obj.layer_id,
          component_ref: obj.component_ref ?? undefined,
          pin_ref: obj.pin_ref ?? undefined,
          obj_type: 3, // Assume pad for now
          net_name: undefined,
          instance_index: undefined,
          shape_index: undefined,
          vertex_ranges: [],
        }));
        ctx.boundsDebugOverlay.setRustBounds(ranges);
        scene.state.needsDraw = true;
      }
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
    
    // Layer pairs for flip operations
    if (data.command === "layerPairs" && data.pairs) {
      const pairs = data.pairs as Record<string, string>;
      scene.setLayerPairs(pairs);
      console.log(`[Flip] Received ${Object.keys(pairs).length / 2} layer pairs for flip operations`);
      return;
    }
    
    // Flip complete - layer remapping is already done in main.ts before FlipObjects was sent
    // This just confirms the operation completed and updates any remaining selectedObjects
    if (data.command === "flipComplete") {
      const layerRemapping = data.layerRemapping as Record<string, string>;
      const flippedCount = data.flippedCount as number;
      const flippedObjectIds = (data.objectIds as number[]) || [];
      
      console.log(`[Flip] Flip complete: ${flippedCount} objects, layer pairs:`, Object.keys(layerRemapping).length);
      console.log(`[Flip] flipComplete objectIds (${flippedObjectIds.length}): first 8 -> ${flippedObjectIds.slice(0, 8).join(', ')}`);

      // Update layer_id on any selected objects that still have old layer_id
      if (Object.keys(layerRemapping).length > 0) {
        for (const obj of ctx.selectedObjects) {
          const newLayerId = layerRemapping[obj.layer_id];
          if (newLayerId) {
            obj.layer_id = newLayerId;
          }
        }
      }

      // Fallback: ensure every flipped object has a render-layer mapping even if pre-recording was missed
      if (flippedObjectIds.length > 0) {
        // Invert the remapping so we can recover the original render layer from the new logical layer
        const inverseRemap = new Map<string, string>();
        for (const [from, to] of Object.entries(layerRemapping)) {
          inverseRemap.set(to, from);
        }

        let mappedCount = 0;
        let missingPreFlip = 0;
        let missingAll = 0;
        for (const objId of flippedObjectIds) {
          const preFlipLayer = ctx.preFlipRenderLayerById.get(objId);
          const selected = ctx.selectedObjects.find(o => o.id === objId);
          const logicalLayer = selected?.layer_id;
          const guessedOriginal = logicalLayer ? (inverseRemap.get(logicalLayer) || logicalLayer) : undefined;
          const renderLayer = preFlipLayer || guessedOriginal;

          if (renderLayer) {
            scene.remapObjectRenderLayer(objId, renderLayer);
            mappedCount++;
          } else {
            if (!preFlipLayer) missingPreFlip++;
            missingAll++;
          }
        }
        console.log(`[Flip] Fallback render-layer remap: mapped=${mappedCount}, missingPreFlip=${missingPreFlip}, missingAll=${missingAll}`);
        ctx.preFlipRenderLayerById.clear();
      }
      return;
    }

    // ==================== New Transform API ====================
    
    if (data.command === "transformStarted") {
      const center = data.center as { x: number; y: number };
      const objectCount = data.objectCount as number;
      console.log(`[Transform] Started: ${objectCount} objects, center=(${center.x.toFixed(3)}, ${center.y.toFixed(3)})`);
      // Store center for UI display if needed
      return;
    }
    
    if (data.command === "transformPreviewResult") {
      const instances = data.instances as TransformedInstance[];
      console.log(`[Transform] Preview: ${instances.length} instances, rot=${data.rotationDegrees}°, flipped=${data.isFlipped}`);
      
      // Update GPU buffers with transformed positions
      // Use original_layer_id because that's where the buffer data actually lives
      for (const inst of instances) {
        scene.updateInstancePosition(inst.object_id, inst.original_layer_id, inst.x, inst.y, inst.packed_rot_vis, inst.shape_idx, inst.instance_idx);
      }
      scene.state.needsDraw = true;
      return;
    }
    
    if (data.command === "transformApplied") {
      const transformedCount = data.transformedCount as number;
      console.log(`[Transform] Applied: ${transformedCount} objects committed`);
      // Clear moving flags on all transformed instances
      scene.clearMovingFlags();
      return;
    }
    
    if (data.command === "transformCancelled") {
      const instances = data.instances as TransformedInstance[] | undefined;
      console.log(`[Transform] Cancelled`);
      
      // If server sends original positions, use them. Otherwise use locally stored originals.
      if (instances && instances.length > 0) {
        for (const inst of instances) {
          scene.updateInstancePosition(inst.object_id, inst.original_layer_id, inst.x, inst.y, inst.packed_rot_vis, inst.shape_idx, inst.instance_idx);
        }
        scene.clearMovingFlags(); // Just clear flags, positions already restored
      } else {
        // Use locally stored original positions
        scene.restoreOriginalPositions();
      }
      scene.state.needsDraw = true;
      return;
    }
    
    if (data.command === "transformError") {
      console.error('[Transform] Error:', data.error);
      return;
    }
    
    if (data.command === "undoTransformResult") {
      const instances = data.instances as TransformedInstance[] | undefined;
      const message = data.message as string | undefined;
      
      if (message) {
        console.log(`[Undo] ${message}`);
      }
      
      if (instances && instances.length > 0) {
        console.log(`[Undo] Restoring ${instances.length} instances to original positions`);
        for (const inst of instances) {
          scene.updateInstancePosition(inst.object_id, inst.original_layer_id, inst.x, inst.y, inst.packed_rot_vis, inst.shape_idx, inst.instance_idx);
        }
        scene.state.needsDraw = true;
      }
      return;
    }
    
    if (data.command === "redoTransformResult") {
      const instances = data.instances as TransformedInstance[] | undefined;
      const message = data.message as string | undefined;
      
      if (message) {
        console.log(`[Redo] ${message}`);
      }
      
      if (instances && instances.length > 0) {
        console.log(`[Redo] Restoring ${instances.length} instances to transformed positions`);
        for (const inst of instances) {
          scene.updateInstancePosition(inst.object_id, inst.original_layer_id, inst.x, inst.y, inst.packed_rot_vis, inst.shape_idx, inst.instance_idx);
        }
        scene.state.needsDraw = true;
      }
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
    
    // Update bounds debug overlay with selection (Rust bounds = what LSP returned)
    if (ctx.boundsDebugOverlay) {
      ctx.boundsDebugOverlay.setRustBounds(visibleRanges);
      // Also set TS bounds initially (they match until transforms are applied)
      ctx.boundsDebugOverlay.setTsBounds(visibleRanges);
    }
    
    if (isBoxSelect) {
      // Box select changes selection - disable rotation
      scene.clearComponentPolylineData();
      input.setRotationEnabled(false);
      ctx.selectedObjects = visibleRanges;
      scene.highlightMultipleObjects(visibleRanges);
      input.hideTooltip();
    } else if (isCtrlSelect) {
      // Ctrl-click changes selection - disable rotation
      scene.clearComponentPolylineData();
      input.setRotationEnabled(false);
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
        // Clicking on already-selected object - start move, DON'T disable rotation
        console.log(`[Select] Clicked on already-selected object ${selected.id}, starting move mode`);
        input.startMoveMode(lastSelectX, lastSelectY);
      } else {
        // New selection - disable rotation
        scene.clearComponentPolylineData();
        input.setRotationEnabled(false);
        ctx.selectedObjects = [selected];
        scene.highlightObject(selected);
      }
    }
    
    ctx.lastNetHighlightAllObjects = [];
    input.setHasSelection(ctx.selectedObjects.length > 0);
    input.setHasComponentSelection(ctx.selectedObjects.some(obj => obj.component_ref));
    input.setHasNetSelection(ctx.selectedObjects.some(obj => obj.net_name && obj.net_name !== 'No Net'));
  } else if (!isCtrlSelect) {
    // No visible ranges - clear selection and disable rotation
    scene.clearComponentPolylineData();
    input.setRotationEnabled(false);
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
  
  // Net highlight - disable rotation (not component-based)
  scene.clearComponentPolylineData();
  input.setRotationEnabled(false);
  
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
    
    // Enable rotation only for SINGLE component selection
    // All visible objects must belong to the same component
    const uniqueComponentRefs = new Set(visibleObjects.map(o => o.component_ref).filter(Boolean));
    const isSingleComponent = uniqueComponentRefs.size === 1 && componentRefs.length === 1;
    
    if (isSingleComponent) {
      const componentRef = componentRefs[0];
      console.log(`[HighlightComponents] Single component selected: ${componentRef} - enabling rotation`);
      
      // Compute local coordinates for polylines and store in scene
      scene.computeComponentPolylineLocalCoords(visibleObjects);
      input.setRotationEnabled(true);
    } else {
      console.log(`[HighlightComponents] Multiple components (${uniqueComponentRefs.size}) - rotation disabled`);
      scene.clearComponentPolylineData();
      input.setRotationEnabled(false);
    }
  } else {
    // No visible objects - disable rotation
    scene.clearComponentPolylineData();
    input.setRotationEnabled(false);
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

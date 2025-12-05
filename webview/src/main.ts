import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { ObjectRange } from "./types";
import { BinaryParserPool } from "./parsing/BinaryParserPool";
import { DebugOverlay, DEBUG_SHOW_COORDS } from "./debug/DebugOverlay";
import { setupDevConsole, setupVSCodeConsoleForwarding } from "./debug/devConsole";
import { setupMessageHandler, MessageHandlerContext, UndoAction } from "./messageHandler";

// ==================== Environment Detection ====================

const isVSCodeWebview = !!(window as any).acquireVsCodeApi;
const vscode = isVSCodeWebview ? (window as any).acquireVsCodeApi() : null;

// Make vscode API globally available for UI components
if (vscode) {
  (window as any).vscode = vscode;
}

// Setup console based on environment
if (!isVSCodeWebview) {
  setupDevConsole();
} else if (vscode) {
  setupVSCodeConsoleForwarding(vscode);
}

// ==================== Main Init ====================

async function init() {
  const initStart = performance.now();
  console.log('[INIT] Starting initialization...');
  console.log(`[INIT] Mode: ${isVSCodeWebview ? 'VS Code Extension' : 'Dev Server'}`);
  
  const canvasElement = document.getElementById("viewer");
  if (!(canvasElement instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element #viewer was not found");
  }

  // Initialize core components
  const scene = new Scene();
  const renderer = new Renderer(canvasElement, scene);
  const ui = new UI(scene, renderer);
  
  console.log('[INIT] Initializing WebGPU renderer...');
  await renderer.init();
  console.log('[INIT] WebGPU renderer initialized');
  
  // Create debug overlay
  const debugOverlay = new DebugOverlay(canvasElement, scene, renderer);
  if (!DEBUG_SHOW_COORDS) {
    debugOverlay.setVisible(false);
  }
  ui.setDebugOverlay(debugOverlay);
  
  // Shared state for message handling
  const ctx: MessageHandlerContext = {
    scene, renderer, ui, input: null as any, debugOverlay,
    workerPool: new BinaryParserPool(),
    isVSCodeWebview, vscode,
    selectedObjects: [],
    deletedObjectIds: new Set<number>(),
    isBoxSelect: false,
    isCtrlSelect: false,
    lastNetHighlightAllObjects: [],
    lastSelectX: 0,
    lastSelectY: 0,
    undoStack: [] as UndoAction[],
    redoStack: [] as UndoAction[],
  };
  
  console.log(`[INIT] Worker pool created with ${ctx.workerPool.getStats().totalWorkers} workers`);

  // ==================== Undo/Redo System ====================
  
  const MAX_UNDO_HISTORY = 100;

  function performDelete(objects: ObjectRange[], source: string) {
    if (objects.length === 0) return;
    
    console.log(`[Delete] Deleting ${objects.length} object(s) (${source})`);
    scene.clearHighlightObject();
    
    for (const obj of objects) {
      scene.hideObject(obj);
      ctx.deletedObjectIds.add(obj.id);
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ command: 'Delete', object: obj });
      }
    }
    
    ctx.undoStack.push({ type: 'delete', objects: [...objects] });
    if (ctx.undoStack.length > MAX_UNDO_HISTORY) ctx.undoStack.shift();
    ctx.redoStack.length = 0;
    ctx.selectedObjects = [];
    console.log(`[Delete] Deleted ${objects.length} object(s)`);
  }

  function performUndo() {
    if (ctx.undoStack.length === 0) {
      console.log('[Undo] Nothing to undo');
      return;
    }
    
    const action = ctx.undoStack.pop()!;
    
    if (action.type === 'delete') {
      console.log(`[Undo] Restoring ${action.objects.length} deleted object(s)`);
      for (const obj of action.objects) {
        scene.showObject(obj);
        ctx.deletedObjectIds.delete(obj.id);
        if (isVSCodeWebview && vscode) {
          vscode.postMessage({ command: 'Undo', object: obj });
        }
      }
    } else if (action.type === 'move') {
      console.log(`[Undo] Reversing move of ${action.objects.length} object(s)`);
      scene.applyMoveOffset(action.objects, -action.deltaX, -action.deltaY);
      
      const movedIds = new Set(action.objects.map(o => o.id));
      for (const obj of ctx.selectedObjects) {
        if (movedIds.has(obj.id)) {
          obj.bounds[0] -= action.deltaX;
          obj.bounds[1] -= action.deltaY;
          obj.bounds[2] -= action.deltaX;
          obj.bounds[3] -= action.deltaY;
          if (obj.component_center) {
            obj.component_center[0] -= action.deltaX;
            obj.component_center[1] -= action.deltaY;
          }
        }
      }
      for (const obj of action.objects) {
        obj.bounds[0] -= action.deltaX;
        obj.bounds[1] -= action.deltaY;
        obj.bounds[2] -= action.deltaX;
        obj.bounds[3] -= action.deltaY;
        if (obj.component_center) {
          obj.component_center[0] -= action.deltaX;
          obj.component_center[1] -= action.deltaY;
        }
      }
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'UndoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
        });
      }
    } else if (action.type === 'rotate') {
      console.log(`[Undo] Reversing rotation of ${action.objects.length} object(s)`);
      
      // Use the NEGATED stored perObjectOffsets for undo
      const reverseRotation = -action.rotationDelta;
      const reversePerObjectOffsets = new Map<number, { dx: number; dy: number }>();
      const reversePerObjectOffsetsArray: { id: number; dx: number; dy: number }[] = [];
      for (const o of action.perObjectOffsets) {
        reversePerObjectOffsets.set(o.id, { dx: -o.dx, dy: -o.dy });
        reversePerObjectOffsetsArray.push({ id: o.id, dx: -o.dx, dy: -o.dy });
      }
      
      // Update bounds in the stored action using negated offsets
      for (const obj of action.objects) {
        const offset = reversePerObjectOffsets.get(obj.id);
        if (offset) {
          const halfW = (obj.bounds[2] - obj.bounds[0]) / 2;
          const halfH = (obj.bounds[3] - obj.bounds[1]) / 2;
          const centerX = (obj.bounds[0] + obj.bounds[2]) / 2 + offset.dx;
          const centerY = (obj.bounds[1] + obj.bounds[3]) / 2 + offset.dy;
          obj.bounds[0] = centerX - halfW;
          obj.bounds[1] = centerY - halfH;
          obj.bounds[2] = centerX + halfW;
          obj.bounds[3] = centerY + halfH;
        }
      }
      
      // Pass pre-calculated offsets to avoid double-calculation
      scene.applyRotation(action.objects, reverseRotation, action.componentCenter, reversePerObjectOffsets);
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'RotateObjects', 
          objectIds: action.objects.map(o => o.id),
          rotationDelta: reverseRotation,
          componentCenter: action.componentCenter,
          perObjectOffsets: reversePerObjectOffsetsArray
        });
      }
    } else if (action.type === 'move_rotate') {
      console.log(`[Undo] Reversing combined move+rotate of ${action.objects.length} object(s)`);
      console.log(`[Undo] action.deltaX=${action.deltaX.toFixed(4)}, action.deltaY=${action.deltaY.toFixed(4)}`);
      console.log(`[Undo] action.rotationDelta=${action.rotationDelta.toFixed(6)} rad (${(action.rotationDelta * 180 / Math.PI).toFixed(2)}°)`);
      console.log(`[Undo] action.componentCenter=(${action.componentCenter.x.toFixed(4)}, ${action.componentCenter.y.toFixed(4)})`);
      
      // Log bounds of first few objects before undo
      for (let i = 0; i < Math.min(3, action.objects.length); i++) {
        const obj = action.objects[i];
        console.log(`[Undo] Before: obj[${i}] id=${obj.id} type=${obj.obj_type} bounds=[${obj.bounds.map(b => b.toFixed(4)).join(', ')}]`);
      }
      
      // For combined move+rotate, we need to reverse in REVERSE order:
      // Original: move first, then rotate around ORIGINAL center
      // Undo: reverse move first, then reverse rotation around ORIGINAL center
      
      // 1. First reverse the move
      console.log(`[Undo] Step 1: applyMoveOffset(${(-action.deltaX).toFixed(4)}, ${(-action.deltaY).toFixed(4)})`);
      scene.applyMoveOffset(action.objects, -action.deltaX, -action.deltaY);
      
      // 2. Then reverse the rotation around the ORIGINAL center
      // IMPORTANT: Use the NEGATED stored perObjectOffsets for pads, not recalculated ones!
      // After step 1, pads are at rotated-only positions, not original positions.
      // The stored offsets were calculated during the original operation, so negating them gives correct reverse.
      const reverseRotation = -action.rotationDelta;
      const reversePerObjectOffsets = new Map<number, { dx: number; dy: number }>();
      for (const o of action.perObjectOffsets) {
        reversePerObjectOffsets.set(o.id, { dx: -o.dx, dy: -o.dy });
      }
      console.log(`[Undo] Step 2: applyRotation(${reverseRotation.toFixed(6)} rad, center=(${action.componentCenter.x.toFixed(4)}, ${action.componentCenter.y.toFixed(4)}), using stored offsets)`);
      scene.applyRotation(action.objects, reverseRotation, action.componentCenter, reversePerObjectOffsets);
      
      // Update component_center in ctx.selectedObjects so subsequent rotations use correct center
      const movedIds = new Set(action.objects.map(o => o.id));
      for (const obj of ctx.selectedObjects) {
        if (movedIds.has(obj.id) && obj.component_center) {
          obj.component_center[0] -= action.deltaX;
          obj.component_center[1] -= action.deltaY;
        }
      }
      
      // Note: We do NOT update action.objects bounds - they should stay at original
      // so that redo can correctly re-apply the move+rotate from original state
      
      if (isVSCodeWebview && vscode) {
        // Send reverse move first
        vscode.postMessage({ 
          command: 'UndoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
        });
        // Send reverse rotation (around original center)
        const reversePerObjectOffsetsArray = action.perObjectOffsets.map(o => ({ id: o.id, dx: -o.dx, dy: -o.dy }));
        vscode.postMessage({ 
          command: 'RotateObjects', 
          objectIds: action.objects.map(o => o.id),
          rotationDelta: reverseRotation,
          componentCenter: action.componentCenter,
          perObjectOffsets: reversePerObjectOffsetsArray
        });
      }
    }
    
    ctx.redoStack.push(action);
    if (ctx.redoStack.length > MAX_UNDO_HISTORY) ctx.redoStack.shift();
  }

  function performRedo() {
    if (ctx.redoStack.length === 0) {
      console.log('[Redo] Nothing to redo');
      return;
    }
    
    const action = ctx.redoStack.pop()!;
    
    if (action.type === 'delete') {
      console.log(`[Redo] Re-deleting ${action.objects.length} object(s)`);
      for (const obj of action.objects) {
        scene.hideObject(obj);
        ctx.deletedObjectIds.add(obj.id);
        if (isVSCodeWebview && vscode) {
          vscode.postMessage({ command: 'Redo', object: obj });
        }
      }
    } else if (action.type === 'move') {
      console.log(`[Redo] Re-applying move of ${action.objects.length} object(s)`);
      scene.applyMoveOffset(action.objects, action.deltaX, action.deltaY);
      
      const movedIds = new Set(action.objects.map(o => o.id));
      for (const obj of ctx.selectedObjects) {
        if (movedIds.has(obj.id)) {
          obj.bounds[0] += action.deltaX;
          obj.bounds[1] += action.deltaY;
          obj.bounds[2] += action.deltaX;
          obj.bounds[3] += action.deltaY;
          if (obj.component_center) {
            obj.component_center[0] += action.deltaX;
            obj.component_center[1] += action.deltaY;
          }
        }
      }
      for (const obj of action.objects) {
        obj.bounds[0] += action.deltaX;
        obj.bounds[1] += action.deltaY;
        obj.bounds[2] += action.deltaX;
        obj.bounds[3] += action.deltaY;
        if (obj.component_center) {
          obj.component_center[0] += action.deltaX;
          obj.component_center[1] += action.deltaY;
        }
      }
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'RedoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
        });
      }
    } else if (action.type === 'rotate') {
      console.log(`[Redo] Re-applying rotation of ${action.objects.length} object(s)`);
      
      // Use stored perObjectOffsets for redo
      const preCalcOffsets = new Map<number, { dx: number; dy: number }>();
      for (const o of action.perObjectOffsets) {
        preCalcOffsets.set(o.id, { dx: o.dx, dy: o.dy });
      }
      
      // Update bounds in the stored action using stored offsets
      for (const obj of action.objects) {
        const offset = preCalcOffsets.get(obj.id);
        if (offset) {
          const halfW = (obj.bounds[2] - obj.bounds[0]) / 2;
          const halfH = (obj.bounds[3] - obj.bounds[1]) / 2;
          const centerX = (obj.bounds[0] + obj.bounds[2]) / 2 + offset.dx;
          const centerY = (obj.bounds[1] + obj.bounds[3]) / 2 + offset.dy;
          obj.bounds[0] = centerX - halfW;
          obj.bounds[1] = centerY - halfH;
          obj.bounds[2] = centerX + halfW;
          obj.bounds[3] = centerY + halfH;
        }
      }
      
      // Pass pre-calculated offsets to avoid double-calculation
      scene.applyRotation(action.objects, action.rotationDelta, action.componentCenter, preCalcOffsets);
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'RotateObjects', 
          objectIds: action.objects.map(o => o.id),
          rotationDelta: action.rotationDelta,
          componentCenter: action.componentCenter,
          perObjectOffsets: action.perObjectOffsets
        });
      }
    } else if (action.type === 'move_rotate') {
      console.log(`[Redo] Re-applying combined move+rotate of ${action.objects.length} object(s)`);
      
      // Re-apply move first
      scene.applyMoveOffset(action.objects, action.deltaX, action.deltaY);
      
      // Update bounds for move
      for (const obj of action.objects) {
        obj.bounds[0] += action.deltaX;
        obj.bounds[1] += action.deltaY;
        obj.bounds[2] += action.deltaX;
        obj.bounds[3] += action.deltaY;
      }
      
      // Update component_center in ctx.selectedObjects so subsequent rotations use correct center
      const movedIds = new Set(action.objects.map(o => o.id));
      for (const obj of ctx.selectedObjects) {
        if (movedIds.has(obj.id) && obj.component_center) {
          obj.component_center[0] += action.deltaX;
          obj.component_center[1] += action.deltaY;
        }
      }
      
      // Re-apply rotation with stored offsets
      const preCalcOffsets = new Map<number, { dx: number; dy: number }>();
      for (const o of action.perObjectOffsets) {
        preCalcOffsets.set(o.id, { dx: o.dx, dy: o.dy });
      }
      scene.applyRotation(action.objects, action.rotationDelta, action.componentCenter, preCalcOffsets);
      
      // Update bounds for rotation offsets
      for (const offset of action.perObjectOffsets) {
        const obj = action.objects.find(o => o.id === offset.id);
        if (obj) {
          obj.bounds[0] += offset.dx;
          obj.bounds[1] += offset.dy;
          obj.bounds[2] += offset.dx;
          obj.bounds[3] += offset.dy;
        }
      }
      
      if (isVSCodeWebview && vscode) {
        // Send move
        vscode.postMessage({ 
          command: 'RedoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
        });
        // Send rotation
        vscode.postMessage({ 
          command: 'RotateObjects', 
          objectIds: action.objects.map(o => o.id),
          rotationDelta: action.rotationDelta,
          componentCenter: action.componentCenter,
          perObjectOffsets: action.perObjectOffsets
        });
      }
    }
    
    ctx.undoStack.push(action);
    if (ctx.undoStack.length > MAX_UNDO_HISTORY) ctx.undoStack.shift();
  }

  // ==================== Input Setup ====================
  
  const input = new Input(scene, renderer, ui, (x, y, ctrlKey) => {
    ctx.isBoxSelect = false;
    ctx.isCtrlSelect = ctrlKey;
    ctx.lastSelectX = x;
    ctx.lastSelectY = y;
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'Select', x, y });
    } else {
      console.log(`[Dev] Select at ${x}, ${y}${ctrlKey ? ' (Ctrl+click, append mode)' : ''}`);
    }
  });
  
  ctx.input = input;

  input.setOnBoxSelect((minX, minY, maxX, maxY) => {
    ctx.isBoxSelect = true;
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'BoxSelect', minX, minY, maxX, maxY });
    } else {
      console.log(`[Dev] Box select: (${minX}, ${minY}) to (${maxX}, ${maxY})`);
    }
  });
  
  input.setOnHighlightNets(() => {
    if (ctx.selectedObjects.length === 0) return;
    const objectIds = ctx.selectedObjects.map(obj => obj.id);
    console.log(`[HighlightNets] Requesting nets for ${objectIds.length} selected object(s)`);
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'HighlightSelectedNets', objectIds });
    }
  });
  
  input.setOnHighlightComponents(() => {
    if (ctx.selectedObjects.length === 0) return;
    const objectIds = ctx.selectedObjects.map(obj => obj.id);
    console.log(`[HighlightComponents] Requesting components for ${objectIds.length} selected object(s)`);
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'HighlightSelectedComponents', objectIds });
    }
  });
  
  input.setOnQueryNetAtPoint((worldX: number, worldY: number, clientX: number, clientY: number) => {
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'QueryNetAtPoint', x: worldX, y: worldY, clientX, clientY });
    }
  });
  
  input.setOnShowOnlySelectedNetLayers(() => {
    const objectsToUse = ctx.lastNetHighlightAllObjects.length > 0 
      ? ctx.lastNetHighlightAllObjects 
      : ctx.selectedObjects;
    
    if (objectsToUse.length === 0) return;
    
    const selectedLayerIds = new Set<string>();
    for (const obj of objectsToUse) {
      if (obj.obj_type === 2) continue; // Skip vias
      if (obj.layer_id.includes('PTH') || obj.layer_id.includes('Drill')) continue;
      selectedLayerIds.add(obj.layer_id);
    }
    
    if (selectedLayerIds.size === 0) {
      console.log('[ShowOnlyNetLayers] All selected objects are vias/PTH');
      return;
    }
    
    console.log(`[ShowOnlyNetLayers] Showing only layers: ${Array.from(selectedLayerIds).join(', ')}`);
    
    for (const [layerId] of scene.layerVisible) {
      scene.toggleLayerVisibility(layerId, selectedLayerIds.has(layerId));
    }
    ui.updateLayerVisibility(selectedLayerIds);
    
    const visibleObjects = objectsToUse.filter(obj => selectedLayerIds.has(obj.layer_id));
    if (visibleObjects.length > 0) {
      ctx.selectedObjects = visibleObjects;
      scene.highlightMultipleObjects(visibleObjects);
    }
  });
  
  ui.setOnDelete(() => {
    if (ctx.selectedObjects.length > 0) performDelete(ctx.selectedObjects, 'context menu');
  });
  
  input.setOnDelete(() => {
    if (ctx.selectedObjects.length > 0) performDelete(ctx.selectedObjects, 'keyboard');
  });

  input.setOnUndo(() => performUndo());
  input.setOnRedo(() => performRedo());

  input.setOnClearSelection(() => {
    // Clear object selection
    if (ctx.selectedObjects.length > 0) {
      console.log('[Input] Escape pressed - clearing selection');
      ctx.selectedObjects = [];
      scene.clearHighlightObject();
      ui.clearHighlight();
      input.setHasSelection(false);
      input.setHasComponentSelection(false);
      
      // Disable rotation when selection is cleared
      scene.clearComponentPolylineData();
      input.setRotationEnabled(false);
    }
    // Also clear DRC highlight
    ui.clearDrcHighlight();
  });

  // ==================== Move Operations ====================
  
  input.setGetSelectedObjects(() => ctx.selectedObjects);
  
  input.setOnMoveStart(() => {
    if (ctx.selectedObjects.length === 0) return;
    console.log(`[Move] Starting move for ${ctx.selectedObjects.length} objects`);
    scene.startMove(ctx.selectedObjects);
  });
  
  input.setOnMoveUpdate((deltaX: number, deltaY: number) => {
    scene.updateMove(deltaX, deltaY);
  });
  
  input.setOnMoveCancel(() => {
    scene.cancelMove();
    console.log('[Move] Move cancelled');
  });
  
  input.setOnMoveEnd((deltaX: number, deltaY: number) => {
    const result = scene.endMove();
    const hasMoved = Math.abs(result.deltaX) > 0.0001 || Math.abs(result.deltaY) > 0.0001;
    const hasRotated = Math.abs(result.rotationDelta) > 0.0001;
    
    if (!hasMoved && !hasRotated) {
      console.log('[Move] Move ended with no significant transformation');
      return;
    }
    
    console.log(`[Move] Move ended: delta=(${result.deltaX}, ${result.deltaY}), rotation=${(result.rotationDelta * 180 / Math.PI).toFixed(1)}°`);
    const objectIds = ctx.selectedObjects.map(obj => obj.id);
    
    // IMPORTANT: Capture original bounds BEFORE updating them
    // For move_rotate, we need true original bounds (before move AND rotation)
    const originalBoundsMap = new Map<number, [number, number, number, number]>();
    for (const obj of ctx.selectedObjects) {
      originalBoundsMap.set(obj.id, [...obj.bounds] as [number, number, number, number]);
    }
    
    // Update local bounds for moved objects
    if (hasMoved) {
      for (const obj of ctx.selectedObjects) {
        obj.bounds[0] += result.deltaX;
        obj.bounds[1] += result.deltaY;
        obj.bounds[2] += result.deltaX;
        obj.bounds[3] += result.deltaY;
        // Also update component_center so subsequent rotations use the new center
        if (obj.component_center) {
          obj.component_center[0] += result.deltaX;
          obj.component_center[1] += result.deltaY;
        }
      }
    }
    
    // Update bounds for rotation (objects orbit around component center)
    if (hasRotated && result.componentCenter) {
      for (const obj of ctx.selectedObjects) {
        const rotOffset = result.perObjectOffsets.get(obj.id);
        if (rotOffset) {
          obj.bounds[0] += rotOffset.dx;
          obj.bounds[1] += rotOffset.dy;
          obj.bounds[2] += rotOffset.dx;
          obj.bounds[3] += rotOffset.dy;
        }
      }
    }
    
    // Create undo entry - use combined type if both move and rotate happened
    if (hasMoved && hasRotated && result.componentCenter) {
      // Combined move+rotate: store TRUE original bounds (before any transformation)
      const perObjectOffsets = Array.from(result.perObjectOffsets.entries()).map(([id, offset]) => ({
        id, dx: offset.dx, dy: offset.dy
      }));
      const objectsForUndo = ctx.selectedObjects.map(obj => ({
        ...obj,
        bounds: originalBoundsMap.get(obj.id) || [...obj.bounds] as [number, number, number, number]
      }));
      ctx.undoStack.push({ 
        type: 'move_rotate', 
        objects: objectsForUndo, 
        deltaX: result.deltaX, 
        deltaY: result.deltaY,
        rotationDelta: result.rotationDelta,
        componentCenter: result.componentCenter,
        perObjectOffsets
      });
    } else if (hasMoved) {
      const objectsForUndo = ctx.selectedObjects.map(obj => ({
        ...obj,
        bounds: [
          obj.bounds[0] - result.deltaX,
          obj.bounds[1] - result.deltaY,
          obj.bounds[2] - result.deltaX,
          obj.bounds[3] - result.deltaY
        ] as [number, number, number, number]
      }));
      ctx.undoStack.push({ type: 'move', objects: objectsForUndo, deltaX: result.deltaX, deltaY: result.deltaY });
    } else if (hasRotated && result.componentCenter) {
      const perObjectOffsets = Array.from(result.perObjectOffsets.entries()).map(([id, offset]) => ({
        id, dx: offset.dx, dy: offset.dy
      }));
      const objectsForUndo = ctx.selectedObjects.map(obj => ({ ...obj }));
      ctx.undoStack.push({ 
        type: 'rotate', 
        objects: objectsForUndo, 
        rotationDelta: result.rotationDelta,
        componentCenter: result.componentCenter,
        perObjectOffsets
      });
    }
    
    if (ctx.undoStack.length > MAX_UNDO_HISTORY) ctx.undoStack.shift();
    ctx.redoStack.length = 0;
    
    // Send to LSP server
    if (isVSCodeWebview && vscode) {
      if (hasMoved) {
        vscode.postMessage({ command: 'MoveObjects', objectIds, deltaX: result.deltaX, deltaY: result.deltaY });
      }
      if (hasRotated && result.componentCenter) {
        // Convert perObjectOffsets Map to array for JSON serialization
        const perObjectOffsets = Array.from(result.perObjectOffsets.entries()).map(([id, offset]) => ({
          id, dx: offset.dx, dy: offset.dy
        }));
        vscode.postMessage({ 
          command: 'RotateObjects', 
          objectIds, 
          rotationDelta: result.rotationDelta,
          componentCenter: result.componentCenter,
          perObjectOffsets
        });
      }
    }
  });
  
  // Rotation during move mode - only works for single component selection
  input.setOnRotate((angleDelta: number) => {
    // If we have selected objects, rotate them
    if (ctx.selectedObjects.length === 0) {
      console.log('[Rotate] No objects selected');
      return;
    }
    
    // Validate: all selected objects must belong to the same component
    const firstComponentRef = ctx.selectedObjects[0].component_ref;
    if (!firstComponentRef) {
      console.log('[Rotate] Selection does not belong to a component - rotation disabled');
      return;
    }
    
    for (const obj of ctx.selectedObjects) {
      if (obj.component_ref !== firstComponentRef) {
        console.log('[Rotate] Selection contains objects from different components - rotation disabled');
        return;
      }
    }
    
    // Check if objects have precomputed polar coordinates
    const hasPolarCoords = ctx.selectedObjects.some(o => o.polar_radius !== undefined);
    if (!hasPolarCoords) {
      console.log('[Rotate] Selected component does not have polar coordinates - rotation disabled');
      return;
    }
    
    // Track if this is a "rotate in place" (not during drag)
    const wasAlreadyMoving = input.getIsMoving();
    
    // If not already in move mode, start it and set up component rotation
    if (scene.movingObjects.length === 0) {
      scene.startMove(ctx.selectedObjects);
      const success = scene.setupComponentRotation(ctx.selectedObjects);
      if (!success) {
        console.log('[Rotate] Failed to set up component rotation');
        scene.cancelMove();
        return;
      }
    } else if (!scene.hasComponentRotation()) {
      // Already moving but no component rotation set up - try to set it up
      const success = scene.setupComponentRotation(ctx.selectedObjects);
      if (!success) {
        console.log('[Rotate] Failed to set up component rotation for moving objects');
        return;
      }
    }
    
    scene.addRotation(angleDelta);
    console.log(`[Rotate] Added ${(angleDelta * 180 / Math.PI).toFixed(0)}° rotation for component ${firstComponentRef}`);
    
    // If this was a "rotate in place" (R pressed without dragging), finalize immediately
    // This creates the undo entry and sends to LSP server
    if (!wasAlreadyMoving) {
      console.log('[Rotate] Finalizing rotate-in-place with deltaX=0, deltaY=0');
      // Trigger the same logic as onMoveEnd with zero delta
      input.triggerMoveEnd(0, 0);
    }
  });

  // ==================== DRC Callbacks ====================
  
  ui.setOnRunDrc(() => {
    console.log('[DRC] Running Full DRC...');
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'RunDRCWithRegions', force_full: true });
    }
  });

  ui.setOnIncrementalDrc(() => {
    console.log('[DRC] Running Incremental DRC...');
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'RunDRCWithRegions', force_full: false });
    }
  });

  ui.setOnDrcNavigate((direction: 'prev' | 'next') => {
    const region = direction === 'next' ? scene.nextDrcRegion() : scene.prevDrcRegion();
    if (region) {
      renderer.fitToBounds(region.bounds, 0.3);
      for (const [layerId] of scene.layerVisible) {
        scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
      }
      ui.updateLayerVisibility(new Set([region.layer_id]));
      ui.updateDrcPanel(scene.drcRegions.length, scene.drcCurrentIndex, region, true);
    }
  });

  ui.setOnDrcSelect((index: number) => {
    const region = scene.navigateToDrcRegion(index);
    if (region) {
      renderer.fitToBounds(region.bounds, 0.3);
      for (const [layerId] of scene.layerVisible) {
        scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
      }
      ui.updateLayerVisibility(new Set([region.layer_id]));
      ui.updateDrcPanel(scene.drcRegions.length, index, region, true);
    }
  });

  ui.setOnDrcClear(() => {
    console.log('[DRC] Clearing DRC highlight');
    scene.drcEnabled = false;
    scene.state.needsDraw = true;
  });

  // ==================== Finalize Init ====================
  
  ui.refreshLayerLegend();
  ui.updateStats(true);
  scene.state.needsDraw = true;
  
  if (isVSCodeWebview && vscode) {
    console.log('[INIT] Notifying extension that webview is ready');
    vscode.postMessage({ command: 'ready' });
  }
  
  // Setup message handling
  setupMessageHandler(ctx);
  
  const initEnd = performance.now();
  console.log(`[INIT] Total initialization time: ${(initEnd - initStart).toFixed(1)}ms`);

  // Trigger GC if available
  if ((globalThis as any).gc) {
    setTimeout(() => {
      console.log('[INIT] Triggering manual GC');
      (globalThis as any).gc();
    }, 5000);
  }

  // Debug controls
  (window as any).debugRender = (type: 'all' | 'batch' | 'instanced' | 'instanced_rot') => {
    renderer.debugRenderType = type;
    scene.state.needsDraw = true;
    console.log(`[Debug] Set render type to: ${type}`);
  };
  (window as any).logFrame = () => {
    renderer.debugLogNextFrame = true;
    scene.state.needsDraw = true;
  };

  // Render loop
  function loop() {
    const wasNeedsDraw = scene.state.needsDraw;
    renderer.render();
    if (debugOverlay && wasNeedsDraw) {
      debugOverlay.render();
    }
    ui.updateStats();
    ui.updateHighlightPosition();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Periodic memory request
  if (isVSCodeWebview && vscode) {
    setInterval(() => {
      vscode.postMessage({ command: 'GetMemory' });
    }, 2000);
  }
}

init().catch((error) => {
  const errorMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[INIT FAILED] ${errorMsg}`);
  if (error instanceof Error && error.stack) {
    console.error(`[INIT FAILED] Stack: ${error.stack}`);
  }
  const panel = document.getElementById("ui");
  if (panel) {
    const message = document.createElement("div");
    message.style.marginTop = "8px";
    message.style.color = "#ff6b6b";
    message.textContent = errorMsg;
    panel.appendChild(message);
  }
});

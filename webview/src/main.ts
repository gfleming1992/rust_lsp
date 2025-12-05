import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { ObjectRange } from "./types";
import { BinaryParserPool } from "./parsing/BinaryParserPool";
import { DebugOverlay, DEBUG_SHOW_COORDS } from "./debug/DebugOverlay";
import { BoundsDebugOverlay } from "./debug/BoundsDebugOverlay";
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
  
  // Create bounds debug overlay for TS vs Rust comparison
  const boundsDebugOverlay = new BoundsDebugOverlay(canvasElement, scene, renderer);
  ui.setBoundsDebugOverlay(boundsDebugOverlay);
  
  // Shared state for message handling
  const ctx: MessageHandlerContext = {
    scene, renderer, ui, input: null as any, debugOverlay, boundsDebugOverlay,
    workerPool: new BinaryParserPool(),
    isVSCodeWebview, vscode,
    selectedObjects: [],
    deletedObjectIds: new Set<number>(),
    isBoxSelect: false,
    isCtrlSelect: false,
    lastNetHighlightAllObjects: [],
    lastSelectX: 0,
    lastSelectY: 0,
    preFlipRenderLayerById: new Map<number, string>(),
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
    // For transforms, use LSP-based undo
    if (isVSCodeWebview && vscode) {
      console.log('[Undo] Sending UndoTransform to LSP');
      vscode.postMessage({ command: 'UndoTransform' });
      return;
    }
    
    // Fallback for dev server - use local undo stack
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
    // For transforms, use LSP-based redo
    if (isVSCodeWebview && vscode) {
      console.log('[Redo] Sending RedoTransform to LSP');
      vscode.postMessage({ command: 'RedoTransform' });
      return;
    }
    
    // Fallback for dev server - use local redo stack
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
      // IMPORTANT: For polylines, we need to rotate around the MOVED center,
      // since applyMoveOffset already translated them
      const preCalcOffsets = new Map<number, { dx: number; dy: number }>();
      for (const o of action.perObjectOffsets) {
        preCalcOffsets.set(o.id, { dx: o.dx, dy: o.dy });
      }
      const movedComponentCenter = {
        x: action.componentCenter.x + action.deltaX,
        y: action.componentCenter.y + action.deltaY
      };
      scene.applyRotation(action.objects, action.rotationDelta, movedComponentCenter, preCalcOffsets);
      
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

  // ==================== Move Operations (LSP-based transforms) ====================
  
  // Track if we're in an active transform session with LSP
  let transformActive = false;
  
  input.setGetSelectedObjects(() => ctx.selectedObjects);
  
  input.setOnMoveStart(() => {
    if (ctx.selectedObjects.length === 0) return;
    
    console.log(`[Transform] Starting transform for ${ctx.selectedObjects.length} objects`);
    
    // Send StartTransform to LSP
    if (isVSCodeWebview && vscode) {
      const objectIds = ctx.selectedObjects.map(obj => obj.id);
      vscode.postMessage({ command: 'StartTransform', objectIds });
      transformActive = true;
    } else {
      // Fallback for dev server - use local scene transform
      scene.startMove(ctx.selectedObjects);
    }
  });
  
  input.setOnMoveUpdate((deltaX: number, deltaY: number) => {
    if (isVSCodeWebview && vscode && transformActive) {
      // Send position update to LSP
      vscode.postMessage({ 
        command: 'TransformPreview', 
        deltaX, 
        deltaY 
      });
    } else {
      // Fallback for dev server
      scene.updateMove(deltaX, deltaY);
    }
  });
  
  input.setOnMoveCancel(() => {
    console.log('[Transform] Transform cancelled');
    
    if (isVSCodeWebview && vscode && transformActive) {
      vscode.postMessage({ command: 'CancelTransform' });
      transformActive = false;
    } else {
      scene.cancelMove();
      scene.resetFlip();
    }
  });
  
  input.setOnMoveEnd((deltaX: number, deltaY: number) => {
    if (isVSCodeWebview && vscode && transformActive) {
      // Send final position update and apply
      vscode.postMessage({ 
        command: 'TransformPreview', 
        deltaX, 
        deltaY 
      });
      // Small delay to ensure preview is processed, then apply
      setTimeout(() => {
        vscode.postMessage({ command: 'ApplyTransform' });
        transformActive = false;
      }, 10);
      
      console.log(`[Transform] Applied: delta=(${deltaX.toFixed(3)}, ${deltaY.toFixed(3)})`);
    } else {
      // Fallback: use old local transform logic for dev server
      const result = scene.endMove();
      const hasMoved = Math.abs(result.deltaX) > 0.0001 || Math.abs(result.deltaY) > 0.0001;
      const hasRotated = Math.abs(result.rotationDelta) > 0.0001;
      
      if (!hasMoved && !hasRotated) {
        console.log('[Move] Move ended with no significant transformation');
        return;
      }
      
      console.log(`[Move] Move ended: delta=(${result.deltaX}, ${result.deltaY})`);
    }
  });
  
  // Rotation during move mode - sends to LSP
  input.setOnRotate((angleDelta: number) => {
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
    
    const rotateDegrees = (angleDelta * 180 / Math.PI);
    console.log(`[Rotate] Rotating ${rotateDegrees.toFixed(0)}° for component ${firstComponentRef}`);
    
    if (isVSCodeWebview && vscode) {
      // If not in transform session, start one
      if (!transformActive) {
        const objectIds = ctx.selectedObjects.map(obj => obj.id);
        vscode.postMessage({ command: 'StartTransform', objectIds });
        transformActive = true;
        
        // Send rotation after a small delay to ensure StartTransform is processed
        setTimeout(() => {
          vscode.postMessage({ command: 'TransformPreview', rotateDegrees });
        }, 10);
      } else {
        // Already in transform session, just send rotation
        vscode.postMessage({ command: 'TransformPreview', rotateDegrees });
      }
      
      // If this was a "rotate in place" (R pressed without dragging), finalize immediately
      if (!input.getIsMoving()) {
        setTimeout(() => {
          vscode.postMessage({ command: 'ApplyTransform' });
          transformActive = false;
        }, 20);
      }
    } else {
      // Fallback for dev server - use old local logic
      if (scene.movingObjects.length === 0) {
        scene.startMove(ctx.selectedObjects);
        scene.setupComponentRotation(ctx.selectedObjects);
      }
      scene.addRotation(angleDelta);
      
      if (!input.getIsMoving()) {
        input.triggerMoveEnd(0, 0);
      }
    }
  });

  // Flip during move mode - sends to LSP
  input.setOnFlip(() => {
    if (ctx.selectedObjects.length === 0) {
      console.log('[Flip] No objects selected');
      return;
    }
    
    // Validate: all selected objects must belong to the same component
    const firstComponentRef = ctx.selectedObjects[0].component_ref;
    if (!firstComponentRef) {
      console.log('[Flip] Selection does not belong to a component - flip disabled');
      return;
    }
    
    for (const obj of ctx.selectedObjects) {
      if (obj.component_ref !== firstComponentRef) {
        console.log('[Flip] Selection contains objects from different components - flip disabled');
        return;
      }
    }
    
    console.log(`[Flip] Flipping component ${firstComponentRef}`);
    
    if (isVSCodeWebview && vscode) {
      // If not in transform session, start one
      if (!transformActive) {
        const objectIds = ctx.selectedObjects.map(obj => obj.id);
        vscode.postMessage({ command: 'StartTransform', objectIds });
        transformActive = true;
        
        // Send flip after a small delay to ensure StartTransform is processed
        setTimeout(() => {
          vscode.postMessage({ command: 'TransformPreview', flip: true });
        }, 10);
      } else {
        // Already in transform session, just send flip
        vscode.postMessage({ command: 'TransformPreview', flip: true });
      }
      
      // If this was a "flip in place" (F pressed without dragging), finalize immediately
      if (!input.getIsMoving()) {
        setTimeout(() => {
          vscode.postMessage({ command: 'ApplyTransform' });
          transformActive = false;
        }, 20);
      }
    } else {
      // Fallback for dev server - use old local logic
      if (scene.movingObjects.length === 0) {
        scene.startMove(ctx.selectedObjects);
        scene.setupComponentRotation(ctx.selectedObjects);
      }
      scene.toggleFlip();
      
      if (!input.getIsMoving()) {
        input.triggerMoveEnd(0, 0);
      }
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
    // Always render bounds overlay (it shows status at bottom)
    if (boundsDebugOverlay) {
      boundsDebugOverlay.render();
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

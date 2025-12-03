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
        }
      }
      for (const obj of action.objects) {
        obj.bounds[0] -= action.deltaX;
        obj.bounds[1] -= action.deltaY;
        obj.bounds[2] -= action.deltaX;
        obj.bounds[3] -= action.deltaY;
      }
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'UndoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
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
        }
      }
      for (const obj of action.objects) {
        obj.bounds[0] += action.deltaX;
        obj.bounds[1] += action.deltaY;
        obj.bounds[2] += action.deltaX;
        obj.bounds[3] += action.deltaY;
      }
      
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ 
          command: 'RedoMove', 
          objectIds: action.objects.map(o => o.id),
          deltaX: action.deltaX, deltaY: action.deltaY
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
    if (Math.abs(result.deltaX) < 0.0001 && Math.abs(result.deltaY) < 0.0001) {
      console.log('[Move] Move ended with no significant movement');
      return;
    }
    
    console.log(`[Move] Move ended: delta=(${result.deltaX}, ${result.deltaY})`);
    const objectIds = ctx.selectedObjects.map(obj => obj.id);
    
    for (const obj of ctx.selectedObjects) {
      obj.bounds[0] += result.deltaX;
      obj.bounds[1] += result.deltaY;
      obj.bounds[2] += result.deltaX;
      obj.bounds[3] += result.deltaY;
    }
    
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
    if (ctx.undoStack.length > MAX_UNDO_HISTORY) ctx.undoStack.shift();
    ctx.redoStack.length = 0;
    
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'MoveObjects', objectIds, deltaX: result.deltaX, deltaY: result.deltaY });
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

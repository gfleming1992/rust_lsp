import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { LayerJSON, ObjectRange } from "./types";
import { BinaryParserPool } from "./BinaryParserPool";
import { parseBinaryLayer } from "./binaryParser";
import { DebugOverlay, DEBUG_SHOW_COORDS } from "./DebugOverlay";

// Detect if running in VS Code webview or dev mode
const isVSCodeWebview = !!(window as any).acquireVsCodeApi;
const vscode = isVSCodeWebview ? (window as any).acquireVsCodeApi() : null;

// Make vscode API globally available for UI components
if (vscode) {
  (window as any).vscode = vscode;
}

// Create debug console overlay for dev server
if (!isVSCodeWebview) {
    const debugConsole = document.createElement('div');
    debugConsole.id = 'debug-console';
    debugConsole.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 300px;
        background: rgba(30, 30, 30, 0.95);
        color: #d4d4d4;
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 12px;
        overflow-y: auto;
        padding: 8px;
        border-top: 2px solid #007acc;
        z-index: 10000;
        display: flex;
        flex-direction: column;
    `;
    
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 4px;
        border-bottom: 1px solid #555;
        margin-bottom: 4px;
        flex-shrink: 0;
    `;
    header.innerHTML = `
        <span style="font-weight: bold; color: #007acc;">[Dev Server Debug Console]</span>
        <button id="clear-console" style="
            background: #007acc;
            color: white;
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 11px;
            border-radius: 3px;
        ">Clear</button>
    `;
    
    const logContainer = document.createElement('div');
    logContainer.id = 'log-container';
    logContainer.style.cssText = 'flex: 1; overflow-y: auto;';
    
    debugConsole.appendChild(header);
    debugConsole.appendChild(logContainer);
    document.body.appendChild(debugConsole);
    
    const clearButton = document.getElementById('clear-console');
    clearButton?.addEventListener('click', () => {
        logContainer.innerHTML = '';
    });
    
    const addLogEntry = (type: string, args: any[]) => {
        const entry = document.createElement('div');
        entry.style.cssText = 'padding: 2px 0; border-bottom: 1px solid #333;';
        
        const typeColors: Record<string, string> = {
            log: '#d4d4d4',
            error: '#f48771',
            warn: '#dcdcaa',
            info: '#4fc1ff'
        };
        
        const timestamp = new Date().toISOString().substring(11, 23);
        const color = typeColors[type] || '#d4d4d4';
        
        const formattedArgs = args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(' ');
        
        entry.innerHTML = `<span style="color: #858585;">[${timestamp}]</span> <span style="color: ${color};">${formattedArgs}</span>`;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    };
    
    // Store originals
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    
    // Intercept console methods for dev server
    console.log = (...args: any[]) => {
        addLogEntry('log', args);
        originalLog.apply(console, args);
    };
    
    console.error = (...args: any[]) => {
        addLogEntry('error', args);
        originalError.apply(console, args);
    };
    
    console.warn = (...args: any[]) => {
        addLogEntry('warn', args);
        originalWarn.apply(console, args);
    };
    
    console.info = (...args: any[]) => {
        addLogEntry('info', args);
        originalInfo.apply(console, args);
    };
}

// Forward console logs to VS Code extension
if (isVSCodeWebview && vscode) {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    // Helper to serialize args, converting Error objects to readable strings
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

async function init() {
  const initStart = performance.now();
  console.log('[INIT] Starting initialization...');
  console.log(`[INIT] Mode: ${isVSCodeWebview ? 'VS Code Extension' : 'Dev Server'}`);
  
  const canvasElement = document.getElementById("viewer");
  if (!(canvasElement instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element #viewer was not found");
  }

  const scene = new Scene();
  const renderer = new Renderer(canvasElement, scene);
  const ui = new UI(scene, renderer);
  
  // Initialize WebGPU first (so renderer has device)
  console.log('[INIT] Initializing WebGPU renderer...');
  await renderer.init();
  console.log('[INIT] WebGPU renderer initialized');
  
  // Create debug overlay for coordinate labels (after renderer init)
  // Always create it so the checkbox can toggle it, but start hidden unless DEBUG_SHOW_COORDS is true
  const debugOverlay = new DebugOverlay(canvasElement, scene, renderer);
  if (!DEBUG_SHOW_COORDS) {
    debugOverlay.setVisible(false);
  }
  
  // Pass debug overlay to UI for checkbox control
  ui.setDebugOverlay(debugOverlay);
  
  // Handle deletion with undo/redo support
  let selectedObjects: ObjectRange[] = [];
  let deletedObjectIds = new Set<number>(); // Track deleted object IDs
  let isBoxSelect = false; // Track if current selection is from box select
  let isCtrlSelect = false; // Track if Ctrl was held during selection (append mode)
  
  // Store full net results (including hidden layers) for "Show only net layers" feature
  let lastNetHighlightAllObjects: ObjectRange[] = [];

  // Setup Input handling
  const input = new Input(scene, renderer, ui, (x, y, ctrlKey) => {
    isBoxSelect = false; // Single point select
    isCtrlSelect = ctrlKey; // Track if appending to selection
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'Select', x, y });
    } else {
      console.log(`[Dev] Select at ${x}, ${y}${ctrlKey ? ' (Ctrl+click, append mode)' : ''}`);
    }
  });

  // Set up box select handler
  input.setOnBoxSelect((minX, minY, maxX, maxY) => {
    isBoxSelect = true; // Box select mode
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'BoxSelect', minX, minY, maxX, maxY });
    } else {
      console.log(`[Dev] Box select: (${minX}, ${minY}) to (${maxX}, ${maxY})`);
    }
  });
  
  // Set up highlight nets handler
  input.setOnHighlightNets(() => {
    if (selectedObjects.length === 0) {
      console.log('[HighlightNets] No objects selected');
      return;
    }
    
    const objectIds = selectedObjects.map(obj => obj.id);
    console.log(`[HighlightNets] Requesting nets for ${objectIds.length} selected object(s)`);
    
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'HighlightSelectedNets', objectIds });
    } else {
      console.log(`[Dev] Highlight nets for objects: ${objectIds.join(', ')}`);
    }
  });
  
  // Set up highlight components handler
  input.setOnHighlightComponents(() => {
    if (selectedObjects.length === 0) {
      console.log('[HighlightComponents] No objects selected');
      return;
    }
    
    const objectIds = selectedObjects.map(obj => obj.id);
    console.log(`[HighlightComponents] Requesting components for ${objectIds.length} selected object(s)`);
    
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'HighlightSelectedComponents', objectIds });
    } else {
      console.log(`[Dev] Highlight components for objects: ${objectIds.join(', ')}`);
    }
  });
  
  // Set up net tooltip query handler
  input.setOnQueryNetAtPoint((worldX: number, worldY: number, clientX: number, clientY: number) => {
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'QueryNetAtPoint', x: worldX, y: worldY, clientX, clientY });
    } else {
      console.log(`[Dev] Query net at point: (${worldX}, ${worldY})`);
    }
  });
  
  // Set up "Show only Selected Net Layers" handler
  input.setOnShowOnlySelectedNetLayers(() => {
    // Use the full net highlight result if available (includes hidden layers),
    // otherwise fall back to currently selected objects
    const objectsToUse = lastNetHighlightAllObjects.length > 0 
      ? lastNetHighlightAllObjects 
      : selectedObjects;
    
    if (objectsToUse.length === 0) {
      console.log('[ShowOnlyNetLayers] No objects selected');
      return;
    }
    
    // Get unique layer IDs from objects, excluding vias (obj_type 2) and PTH pads
    // since they span all copper layers and would cause all copper layers to show
    const selectedLayerIds = new Set<string>();
    for (const obj of objectsToUse) {
      // obj_type: 0=polyline, 1=polygon, 2=via, 3=pad
      // Skip vias (type 2) - they span all copper layers
      if (obj.obj_type === 2) continue;
      // Skip PTH pads - check if layer_id contains multiple copper layers or is a drill layer
      // PTH pads typically appear on multiple layers, we detect them by checking if it's a drill/PTH layer
      if (obj.layer_id.includes('PTH') || obj.layer_id.includes('Drill')) continue;
      selectedLayerIds.add(obj.layer_id);
    }
    
    console.log(`[ShowOnlyNetLayers] Showing only layers: ${Array.from(selectedLayerIds).join(', ')}`);
    
    // If all objects were vias/PTH, don't change visibility
    if (selectedLayerIds.size === 0) {
      console.log('[ShowOnlyNetLayers] All selected objects are vias/PTH, not changing layer visibility');
      return;
    }
    
    // Hide all layers except the selected ones
    for (const [layerId, _visible] of scene.layerVisible) {
      const shouldBeVisible = selectedLayerIds.has(layerId);
      scene.toggleLayerVisibility(layerId, shouldBeVisible);
    }
    
    // Also update UI checkboxes
    ui.updateLayerVisibility(selectedLayerIds);
    
    // Now update the selection to include all objects on the newly visible layers
    const visibleObjects = objectsToUse.filter(obj => selectedLayerIds.has(obj.layer_id));
    if (visibleObjects.length > 0) {
      selectedObjects = visibleObjects;
      scene.highlightMultipleObjects(visibleObjects);
      console.log(`[ShowOnlyNetLayers] Updated selection to ${visibleObjects.length} objects on visible layers`);
    }
  });
  
  // Undo/Redo stacks - store batches of deleted objects for undo/redo as single events
  const MAX_UNDO_HISTORY = 100;
  const undoStack: ObjectRange[][] = []; // Each entry is a batch of objects deleted together
  const redoStack: ObjectRange[][] = [];

  function performDelete(objects: ObjectRange[], source: string) {
    if (objects.length === 0) return;
    
    console.log(`[Delete] Deleting ${objects.length} object(s) (${source})`);
    
    // Clear all highlights first
    scene.clearHighlightObject();
    
    // Hide all objects and track them
    for (const obj of objects) {
      scene.hideObject(obj);
      deletedObjectIds.add(obj.id);
      
      // Send delete command to backend
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ command: 'Delete', object: obj });
      }
    }
    
    // Add entire batch to undo stack as single event
    undoStack.push([...objects]);
    if (undoStack.length > MAX_UNDO_HISTORY) {
      undoStack.shift();
    }
    
    // Clear redo stack when new action is performed
    redoStack.length = 0;
    
    selectedObjects = [];
    console.log(`[Delete] Deleted ${objects.length} object(s)`);
  }

  function performUndo() {
    if (undoStack.length === 0) {
      console.log('[Undo] Nothing to undo');
      return;
    }
    
    const batch = undoStack.pop()!;
    console.log(`[Undo] Restoring ${batch.length} object(s)`);
    
    // Show all objects in the batch
    for (const obj of batch) {
      scene.showObject(obj);
      deletedObjectIds.delete(obj.id);
      
      // Send undo command to backend
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ command: 'Undo', object: obj });
      }
    }
    
    // Add batch to redo stack
    redoStack.push(batch);
    if (redoStack.length > MAX_UNDO_HISTORY) {
      redoStack.shift();
    }
  }

  function performRedo() {
    if (redoStack.length === 0) {
      console.log('[Redo] Nothing to redo');
      return;
    }
    
    const batch = redoStack.pop()!;
    console.log(`[Redo] Re-deleting ${batch.length} object(s)`);
    
    // Hide all objects in the batch again
    for (const obj of batch) {
      scene.hideObject(obj);
      deletedObjectIds.add(obj.id);
      
      // Send redo command to backend
      if (isVSCodeWebview && vscode) {
        vscode.postMessage({ command: 'Redo', object: obj });
      }
    }
    
    // Add batch back to undo stack
    undoStack.push(batch);
    if (undoStack.length > MAX_UNDO_HISTORY) {
      undoStack.shift();
    }
  }
  
  ui.setOnDelete(() => {
    if (selectedObjects.length > 0) {
      performDelete(selectedObjects, 'context menu');
    }
  });
  
  // Hook up Input handlers
  input.setOnDelete(() => {
    if (selectedObjects.length > 0) {
      performDelete(selectedObjects, 'keyboard');
    }
  });

  input.setOnUndo(() => {
    performUndo();
  });

  input.setOnRedo(() => {
    performRedo();
  });

  input.setOnClearSelection(() => {
    if (selectedObjects.length > 0) {
      console.log('[Input] Escape pressed - clearing selection');
      selectedObjects = [];
      scene.clearHighlightObject();
      ui.clearHighlight();
      input.setHasSelection(false);
      input.setHasComponentSelection(false);
    }
  });

  // Initial UI update
  ui.refreshLayerLegend();
  ui.updateStats(true);
  scene.state.needsDraw = true;

  // Notify extension that webview is ready
  if (isVSCodeWebview && vscode) {
    console.log('[INIT] Notifying extension that webview is ready');
    vscode.postMessage({ command: 'ready' });
  }

  // Create worker pool for parallel binary parsing
  const workerPool = new BinaryParserPool();
  console.log(`[INIT] Worker pool created with ${workerPool.getStats().totalWorkers} workers`);

  // Batch layer loading state
  let pendingLayers: LayerJSON[] = [];
  let batchTimeout: number | null = null;
  let initialLoadComplete = false;
  let drcAutoTriggered = false;
  const BATCH_DELAY_MS = 0; // Process immediately - no artificial delay

  function processPendingLayers() {
    if (pendingLayers.length === 0) return;
    
    const batchStart = performance.now();
    console.log(`[BATCH] Processing ${pendingLayers.length} layers at once...`);
    
    // Load all layers
    for (const layerJson of pendingLayers) {
      scene.loadLayerData(layerJson);
    }
    
    // Refresh UI and trigger render
    ui.refreshLayerLegend();
    renderer.finishLoading(); // Allow rendering to begin
    
    // Extract debug points after layers are loaded
    if (debugOverlay) {
      debugOverlay.extractPointsFromLayers();
    }
    
    const batchEnd = performance.now();
    console.log(`[BATCH] Loaded ${pendingLayers.length} layers in ${(batchEnd - batchStart).toFixed(1)}ms`);
    
    pendingLayers = [];
    batchTimeout = null;
    
    // Auto-trigger DRC after initial load completes
    if (!initialLoadComplete) {
      initialLoadComplete = true;
      // Delay slightly to let rendering stabilize
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

  // Listen for messages from extension or dev server
  window.addEventListener("message", async (event) => {
    const msgStart = performance.now();
    const data = event.data as Record<string, unknown>;
    
    // Handle save completion
    if (data.command === "saveComplete") {
      const filePath = data.filePath as string | undefined;
      console.log(`[SAVE] Save completed: ${filePath || 'unknown path'}`);
      
      const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 Save";
      }
      
      return;
    }
    
    // Handle save error
    if (data.command === "saveError") {
      const error = data.error as string | undefined;
      console.error(`[SAVE] Save failed: ${error || 'unknown error'}`);
      
      const saveBtn = document.getElementById("savePcbBtn") as HTMLButtonElement | null;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 Save";
      }
      
      return;
    }
    
    // Handle binary tessellation data
    if (data.command === "binaryTessellationData" && data.binaryPayload) {
      const payload = data.binaryPayload;
      let arrayBuffer: ArrayBuffer;
      
      // Check payload type and convert to ArrayBuffer
      // Minimize copies where possible
      if (payload instanceof ArrayBuffer) {
        // Direct ArrayBuffer (dev server WebSocket) - no copy needed
        arrayBuffer = payload;
      } else if (payload instanceof Uint8Array) {
        // Uint8Array - only slice if offset is non-zero
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
        // VS Code may serialize Uint8Array as plain object {0: byte, 1: byte, ...}
        // Convert back to Uint8Array
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
      
      // Parse using worker pool for parallel parsing
      try {
        const layerJson = await workerPool.parse(arrayBuffer);
        
        pendingLayers.push(layerJson);
        
        if (batchTimeout !== null) {
          clearTimeout(batchTimeout);
        }
        batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      } catch (error) {
        console.error(`[MSG] Binary parsing failed:`, error);
      }
      
    } else if (data.command === "tessellationData" && data.payload) {
      // Handle JSON tessellation data (fallback)
      const layerJson = data.payload as LayerJSON;
      const msgEnd = performance.now();
      console.log(`[MSG] Received JSON ${layerJson.layerId} (parsed in ${(msgEnd - msgStart).toFixed(1)}ms)`);
      
      pendingLayers.push(layerJson);
      
      if (batchTimeout !== null) {
        clearTimeout(batchTimeout);
      }
      batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      
    } else if (data.command === "error") {
      console.error(`Extension error: ${data.message}`);
    } else if (data.command === "selectionResult" && data.ranges) {
      const ranges = data.ranges as ObjectRange[];
      
      // Filter out deleted objects and objects from invisible layers
      const visibleRanges = ranges.filter(range => {
        const isDeleted = deletedObjectIds.has(range.id);
        const isLayerVisible = scene.layerVisible.get(range.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      
      if (visibleRanges.length > 0) {
        // Sort by layer order (later in layerOrder = rendered on top = should be selected first)
        // Use reverse order so topmost layer comes first
        visibleRanges.sort((a, b) => {
          const aIndex = scene.layerOrder.indexOf(a.layer_id);
          const bIndex = scene.layerOrder.indexOf(b.layer_id);
          return bIndex - aIndex; // Higher index = later in render order = on top
        });
        
        if (isBoxSelect) {
          // Box select: select and highlight ALL objects in the box
          selectedObjects = visibleRanges;
          scene.highlightMultipleObjects(visibleRanges);
          // Don't show tooltip for box select (multiple objects)
          input.hideTooltip();
        } else if (isCtrlSelect) {
          // Ctrl+click: append/toggle the topmost object to/from selection
          const newObj = visibleRanges[0];
          const existingIndex = selectedObjects.findIndex(obj => obj.id === newObj.id);
          
          if (existingIndex >= 0) {
            // Already selected - remove it (toggle off)
            selectedObjects.splice(existingIndex, 1);
            console.log(`[Select] Ctrl+click: removed object ${newObj.id} from selection (${selectedObjects.length} remaining)`);
          } else {
            // Not selected - add it
            selectedObjects.push(newObj);
            console.log(`[Select] Ctrl+click: added object ${newObj.id} to selection (${selectedObjects.length} total)`);
          }
          
          // Update highlight for all selected objects
          if (selectedObjects.length > 0) {
            scene.highlightMultipleObjects(selectedObjects);
          } else {
            scene.clearHighlightObject();
          }
          // Don't show tooltip for Ctrl+click (accumulating selection)
          input.hideTooltip();
        } else {
          // Point select: select and highlight only the topmost object
          const selected = visibleRanges[0];
          selectedObjects = [selected];
          scene.highlightObject(selected);
        }
        
        // Clear stored net highlight results since this is a new selection
        lastNetHighlightAllObjects = [];
        
        // Update context menu state
        input.setHasSelection(selectedObjects.length > 0);
        // Check if any selected object has a component_ref
        const hasComponentRef = selectedObjects.some(obj => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        // Check if any selected object has a net_name (for "Show only net layers" option)
        const hasNetName = selectedObjects.some(obj => obj.net_name && obj.net_name !== 'No Net');
        input.setHasNetSelection(hasNetName);
      } else if (!isCtrlSelect) {
        // Only clear selection on empty click if not Ctrl+clicking
        selectedObjects = [];
        lastNetHighlightAllObjects = [];
        scene.clearHighlightObject();
        input.setHasSelection(false);
        input.setHasComponentSelection(false);
        input.setHasNetSelection(false);
        input.hideTooltip();
      }
    } else if (data.command === "highlightNetsResult" && data.objects) {
      const objects = data.objects as ObjectRange[];
      const netNames = data.netNames as string[];
      
      console.log(`[HighlightNets] Received ${objects.length} objects with nets: ${netNames.join(', ')}`);
      
      // Store full result (including hidden layers) for "Show only net layers" feature
      lastNetHighlightAllObjects = objects.filter(obj => !deletedObjectIds.has(obj.id));
      
      // Filter out deleted objects and objects from invisible layers for display
      const visibleObjects = objects.filter(obj => {
        const isDeleted = deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      
      if (visibleObjects.length > 0) {
        selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightNets] Highlighted ${visibleObjects.length} objects for nets: ${netNames.join(', ')}`);
        input.setHasSelection(true);
        // Check if any selected object has a component_ref
        const hasComponentRef = visibleObjects.some(obj => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        // Net highlight results always have nets, so enable "Show only net layers"
        input.setHasNetSelection(true);
      }
    } else if (data.command === "highlightComponentsResult" && data.objects) {
      const objects = data.objects as ObjectRange[];
      const componentRefs = data.componentRefs as string[];
      
      console.log(`[HighlightComponents] Received ${objects.length} objects with components: ${componentRefs.join(', ')}`);
      
      // Filter out deleted objects and objects from invisible layers
      const visibleObjects = objects.filter(obj => {
        const isDeleted = deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
      });
      
      if (visibleObjects.length > 0) {
        selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightComponents] Highlighted ${visibleObjects.length} objects for components: ${componentRefs.join(', ')}`);
        input.setHasSelection(true);
        // Update component selection state
        const hasComponentRef = visibleObjects.some(obj => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        // Check if any component object has a net_name
        const hasNetName = visibleObjects.some(obj => obj.net_name && obj.net_name !== 'No Net');
        input.setHasNetSelection(hasNetName);
      }
    } else if (data.command === "netAtPointResult") {
      // Show tooltip with net name (and component/pin for pads) at the cursor position
      const netName = data.netName as string | null;
      const componentRef = data.componentRef as string | null;
      const pinRef = data.pinRef as string | null;
      const clientX = data.x as number;
      const clientY = data.y as number;
      
      // Show tooltip for any valid net name
      if (netName && netName.trim() !== "") {
        // Build tooltip info
        const tooltipInfo: { net?: string; component?: string; pin?: string } = {
          net: netName
        };
        if (componentRef) {
          tooltipInfo.component = componentRef.replace(/^CMP:/, '');
        }
        if (pinRef) {
          tooltipInfo.pin = pinRef.replace(/^PIN:/, '');
        }
        input.showSelectionTooltip(tooltipInfo, clientX, clientY);
      }
    } else if (data.command === "deleteRelatedObjects" && data.objects) {
      // Handle multi-object deletion (e.g., vias across layers)
      const relatedObjects = data.objects as ObjectRange[];
      console.log(`[Delete] Hiding ${relatedObjects.length} related objects (vias across layers)`);
      
      // Hide all the related objects and track them
      for (const obj of relatedObjects) {
        scene.hideObject(obj);
        deletedObjectIds.add(obj.id);
      }
      
      // Trigger a redraw to reflect visibility changes
      scene.state.needsDraw = true;
    } else if (data.command === "memoryResult") {
      // Handle Rust LSP memory result
      const memoryBytes = data.memoryBytes as number | null;
      ui.setRustMemory(memoryBytes);
    } else if (data.command === "drcRegionsResult") {
      // Handle DRC regions result - load regions into scene and update UI
      const regions = data.regions as import("./types").DrcRegion[];
      const elapsedMs = data.elapsedMs as number;
      console.log(`[DRC] Received ${regions.length} DRC regions in ${elapsedMs.toFixed(2)}ms`);
      
      scene.loadDrcRegions(regions);
      
      // Populate the violation list
      ui.populateDrcList(regions);
      
      // Update UI without navigating to first violation (showNav = false)
      ui.updateDrcPanel(regions.length, 0, null, false);
    }
  });

  // Wire up DRC UI callbacks
  ui.setOnRunDrc(() => {
    console.log('[DRC] Running DRC...');
    if (isVSCodeWebview && vscode) {
      vscode.postMessage({ command: 'RunDRCWithRegions', clearance_mm: 0.15 });
    }
  });

  ui.setOnDrcNavigate((direction: 'prev' | 'next') => {
    const region = direction === 'next' ? scene.nextDrcRegion() : scene.prevDrcRegion();
    if (region) {
      // Fit camera to the violation region
      renderer.fitToBounds(region.bounds, 0.3);
      
      // Show only the affected layer
      for (const [layerId, _visible] of scene.layerVisible) {
        scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
      }
      ui.updateLayerVisibility(new Set([region.layer_id]));
      
      ui.updateDrcPanel(scene.drcRegions.length, scene.drcCurrentIndex, region, true);
    }
  });

  ui.setOnDrcSelect((index: number) => {
    const region = scene.navigateToDrcRegion(index);
    if (region) {
      // Fit camera to the violation region
      renderer.fitToBounds(region.bounds, 0.3);
      
      // Show only the affected layer
      for (const [layerId, _visible] of scene.layerVisible) {
        scene.toggleLayerVisibility(layerId, layerId === region.layer_id);
      }
      ui.updateLayerVisibility(new Set([region.layer_id]));
      
      ui.updateDrcPanel(scene.drcRegions.length, index, region, true);
    }
  });

  ui.setOnClearDrc(() => {
    console.log('[DRC] Clearing DRC');
    scene.clearDrc();
    ui.resetDrcPanel();
    
    // Show all layers again
    for (const [layerId, _visible] of scene.layerVisible) {
      scene.toggleLayerVisibility(layerId, true);
    }
    ui.refreshLayerLegend();
  });
  
  const initEnd = performance.now();
  console.log(`[INIT] Total initialization time: ${(initEnd - initStart).toFixed(1)}ms`);

  // Trigger GC if available (for debugging memory in VS Code)
  if ((globalThis as any).gc) {
    setTimeout(() => {
      console.log('[INIT] Triggering manual GC');
      (globalThis as any).gc();
    }, 5000);
  }

  // Expose debug controls
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
    
    // Render debug overlay after GPU render (only when canvas updated)
    if (debugOverlay && wasNeedsDraw) {
      debugOverlay.render();
    }
    
    ui.updateStats();
    ui.updateHighlightPosition();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Periodic memory request to LSP server (every 2 seconds)
  if (isVSCodeWebview && vscode) {
    setInterval(() => {
      vscode.postMessage({ command: 'GetMemory' });
    }, 2000);
  }
}

init().catch((error) => {
  const errorMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const errorStack = error instanceof Error ? error.stack : '';
  console.error(`[INIT FAILED] ${errorMsg}`);
  if (errorStack) {
    console.error(`[INIT FAILED] Stack: ${errorStack}`);
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

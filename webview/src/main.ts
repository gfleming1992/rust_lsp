import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { LayerJSON } from "./types";
import { BinaryParserPool } from "./BinaryParserPool";

// Detect if running in VS Code webview or dev mode
const isVSCodeWebview = !!(window as any).acquireVsCodeApi;
const vscode = isVSCodeWebview ? (window as any).acquireVsCodeApi() : null;

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

    console.log = (...args) => {
        vscode.postMessage({ command: 'console.log', args });
        originalLog.apply(console, args);
    };
    console.error = (...args) => {
        vscode.postMessage({ command: 'console.error', args });
        originalError.apply(console, args);
    };
    console.warn = (...args) => {
        vscode.postMessage({ command: 'console.warn', args });
        originalWarn.apply(console, args);
    };
    console.info = (...args) => {
        vscode.postMessage({ command: 'console.info', args });
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
  
  // Initialize WebGPU
  console.log('[INIT] Initializing WebGPU renderer...');
  await renderer.init();
  console.log('[INIT] WebGPU renderer initialized');
  
  // Setup Input handling
  new Input(scene, renderer, ui);

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
    
    const batchEnd = performance.now();
    console.log(`[BATCH] Loaded ${pendingLayers.length} layers in ${(batchEnd - batchStart).toFixed(1)}ms`);
    
    pendingLayers = [];
    batchTimeout = null;
  }

  // Listen for messages from extension or dev server
  window.addEventListener("message", async (event) => {
    const msgStart = performance.now();
    const data = event.data as Record<string, unknown>;
    
    // Handle binary tessellation data
    if (data.command === "binaryTessellationData" && data.binaryPayload) {
      const arrayBuffer = data.binaryPayload as ArrayBuffer;
      
      console.log(`[MSG] Binary payload size: ${arrayBuffer.byteLength} bytes, delegating to worker...`);
      
      // Parse in worker (non-blocking)
      const parseStart = performance.now();
      try {
        const layerJson = await workerPool.parse(arrayBuffer);
        const parseEnd = performance.now();
        
        const msgEnd = performance.now();
        console.log(`[MSG] Received binary ${layerJson.layerId} (worker parsed in ${(parseEnd - parseStart).toFixed(1)}ms, total: ${(msgEnd - msgStart).toFixed(1)}ms)`);
        
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
    }
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

  // Render loop
  function loop() {
    renderer.render();
    ui.updateStats();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

init().catch((error) => {
  console.error(error);
  const panel = document.getElementById("ui");
  if (panel) {
    const message = document.createElement("div");
    message.style.marginTop = "8px";
    message.style.color = "#ff6b6b";
    message.textContent = error instanceof Error ? error.message : String(error);
    panel.appendChild(message);
  }
});

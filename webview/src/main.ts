import { Scene } from "./Scene";
import { Renderer } from "./Renderer";
import { UI } from "./UI";
import { Input } from "./Input";
import { LayerJSON } from "./types";
import { parseBinaryLayer } from "./binaryParser";

// Detect if running in VS Code webview or dev mode
const isVSCodeWebview = !!(window as any).acquireVsCodeApi;
const vscode = isVSCodeWebview ? (window as any).acquireVsCodeApi() : null;

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
  await renderer.init();
  
  // Setup Input handling
  new Input(scene, renderer, ui);

  // Initial UI update
  ui.refreshLayerLegend();
  ui.updateStats(true);
  scene.state.needsDraw = true;

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
    
    // Refresh UI and trigger single render
    ui.refreshLayerLegend();
    scene.state.needsDraw = true;
    
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
      
      console.log(`[MSG] Binary payload size: ${arrayBuffer.byteLength} bytes`);
      
      const parseStart = performance.now();
      const layerJson = parseBinaryLayer(arrayBuffer);
      const parseEnd = performance.now();
      
      const msgEnd = performance.now();
      console.log(`[MSG] Received binary ${layerJson.layerId} (parsed in ${(parseEnd - parseStart).toFixed(1)}ms, total: ${(msgEnd - msgStart).toFixed(1)}ms)`);
      
      pendingLayers.push(layerJson);
      
      if (batchTimeout !== null) {
        clearTimeout(batchTimeout);
      }
      batchTimeout = window.setTimeout(processPendingLayers, BATCH_DELAY_MS);
      
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

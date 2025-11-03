/**
 * Test API for webview tessellation rendering
 * 
 * Simulates VS Code extension API by:
 * 1. Intercepting postMessage calls from webview
 * 2. Loading corresponding <test_case_name>.json from test data
 * 3. Returning JSON through simulated message event
 * 4. Rendering to canvas for visual validation
 * 
 * Usage in HTML:
 *   <script>window.__TESSELLATION_TEST = 'layer_LAYER_Design';</script>
 *   <script src="/src/tests.ts" type="module"></script>
 */

// We cannot import LayerJSON due to circular dependency, but that's okay
// since we're just passing JSON data through - the types are checked by main.ts
type LayerJSON = Record<string, unknown>;

interface MockVSCodeAPI {
  postMessage: (msg: unknown) => void;
}

/**
 * Initialize test environment that emulates VS Code extension API
 * Intercepts webview postMessage and responds with JSON from test files
 */
export function initTestMode(testCaseName: string) {
  console.log(`[TEST] Initializing test mode with test case: ${testCaseName}`);
  
  // Create mock VS Code API
  const mockVSCode: MockVSCodeAPI = {
    postMessage: (message: unknown) => {
      console.log(`[TEST] postMessage intercepted:`, message);
      handleTestMessage(message, testCaseName);
    }
  };
  
  // Install mock API on global window
  (window as any).vscode = mockVSCode;
  
  // Simulate initial extension startup message
  setTimeout(() => {
    console.log(`[TEST] Simulating extension startup message`);
    const startupMsg = {
      command: 'loadLayer',
      layerId: testCaseName,
      timestamp: Date.now()
    };
    handleTestMessage(startupMsg, testCaseName);
  }, 100);
}

/**
 * Handle simulated message from "extension"
 * Loads JSON file and posts it back as if from extension
 */
async function handleTestMessage(message: unknown, testCaseName: string) {
  const msg = message as Record<string, unknown>;
  
  if (msg.command === 'loadLayer' || msg.command === 'getTessellation') {
    try {
      console.log(`[TEST] Loading tessellation data: ${testCaseName}`);
      
      // Fetch the JSON file from test data directory
      // Map test case name to JSON file path
      const jsonPath = `/src/test-data/${testCaseName}.json`;
      
      console.log(`[TEST] Fetching from: ${jsonPath}`);
      const response = await fetch(jsonPath);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch ${jsonPath}: ${response.status} ${response.statusText}`);
      }
      
      const layerJson = (await response.json()) as LayerJSON;
      
      console.log(`[TEST] Successfully loaded layer:`, {
        layerId: (layerJson as any).layerId,
        layerName: (layerJson as any).layerName,
        color: (layerJson as any).defaultColor,
        hasBasicGeometry: !!(layerJson as any).geometry?.basic,
        basicLODs: ((layerJson as any).geometry?.basic || []).length,
        hasInstanced: !!(layerJson as any).geometry?.instanced,
        hasBatch: !!(layerJson as any).geometry?.batch,
        batchLODs: ((layerJson as any).geometry?.batch || []).length,
      });
      
      // Simulate receiving message from extension
      // This mimics the real VS Code webview message event
      const mockEvent = new MessageEvent('message', {
        data: {
          command: 'tessellationData',
          payload: layerJson,
          timestamp: Date.now(),
          source: 'test-api'
        }
      });
      
      // Dispatch to window so webview can receive it
      window.dispatchEvent(mockEvent);
      
      console.log(`[TEST] Dispatched tessellation data event`);
      
    } catch (error) {
      console.error(`[TEST] Failed to load tessellation data:`, error);
      
      // Dispatch error event
      const errorEvent = new MessageEvent('message', {
        data: {
          command: 'error',
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
          source: 'test-api'
        }
      });
      window.dispatchEvent(errorEvent);
    }
  }
}

/**
 * Setup webview to listen for test API messages and load all available layers
 * Call this from main.ts to enable test mode
 * 
 * Automatically discovers and loads all layer JSON files from test-data directory
 * Triggers in development (vite/npm) unless explicitly disabled
 */
export async function setupTestListeners() {
    // Auto-enable test mode in development environment (vite/npm)
    // Check if running in VS Code webview context
    const isVSCodeWebview = !!(window as any).acquireVsCodeApi;
    
    if (isVSCodeWebview) {
        console.log('[TEST] Running in VS Code webview - test mode disabled');
        return;
    }
    
    console.log('[TEST] Auto-enabling test mode in development environment');
    
    // Listen for test messages
    window.addEventListener('message', (event) => {
        const data = event.data as Record<string, unknown>;
        
        if (data.source === 'test-api' && data.command === 'tessellationData') {
            console.log('[TEST] Received tessellation data from test API');
            // This will be handled by the main webview code which already listens for messages
            // See main.ts for how it processes LayerJSON
        }
    });
    
    // Discover all available layer files from test-data directory
    const testLayers = await discoverTestLayers();
    
    if (testLayers.length === 0) {
        console.log('[TEST] No test layers found in test-data directory');
        return;
    }
    
    console.log(`[TEST] Discovered ${testLayers.length} test layers:`, testLayers);
    
    // Load all layers sequentially
    for (const layerName of testLayers) {
        console.log(`[TEST] Loading layer: ${layerName}`);
        initTestMode(layerName);
        // Small delay between loading each layer to avoid overwhelming the renderer
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

/**
 * Get list of available test cases from output directory
 * Discovers all layer_*.json files dynamically using Vite's glob
 */
export async function discoverTestLayers(): Promise<string[]> {
  try {
    // Use Vite's glob for development - imports all layer JSON files from output directory
    // @ts-ignore - Vite's glob is not in standard ImportMeta types but works at runtime
    const layerModules = import.meta.glob<{ default: unknown }>('/src/test-data/layer_*.json');    
    const layerNames = Object.keys(layerModules)
      .map(filepath => {
        // Extract filename from path: /output/layer_LAYER_X.json -> layer_LAYER_X
        const match = filepath.match(/\/([^/]+)\.json$/);
        return match ? match[1] : '';
      })
      .filter(Boolean)
      .sort();
    
    console.log('[TEST] Discovered layers:', layerNames);
    return layerNames;
  } catch (error) {
    console.warn('[TEST] Could not discover test layers:', error);
    return [];
  }
}


/**
 * Get list of available test cases from test data directory
 * (For future expansion to support multiple test cases)
 */
export async function getAvailableTestCases(): Promise<string[]> {
  try {
    const response = await fetch('/src/test-data/');
    if (!response.ok) {
      throw new Error(`Failed to fetch test data directory: ${response.status}`);
    }
    const text = await response.text();
    
    // Parse HTML directory listing - look for layer_*.json files
    const jsonFiles = (text.match(/href="(layer_[^"]*\.json)"/g) || [])
      .map(match => match.match(/href="([^"]*)"/)?.[1] || '')
      .map(filename => filename.replace('.json', ''))
      .filter(Boolean)
      .sort();
    
    return jsonFiles;
  } catch (error) {
    console.warn('[TEST] Could not fetch test data directory:', error);
    return [];
  }
}

/**
 * Initialize test rendering with specific test case
 * Can be called from DevTools console: 
 * 
 *   window.__TESSELLATION_TEST = 'layer_LAYER_Design';
 *   import('./tests.ts').then(m => m.initTestMode('layer_LAYER_Design'));
 */
export async function startTest(testCaseName: string) {
  console.log(`[TEST] Starting test: ${testCaseName}`);
  (window as any).__TESSELLATION_TEST = testCaseName;
  initTestMode(testCaseName);
}

export default {
  initTestMode,
  setupTestListeners,
  getAvailableTestCases,
  startTest
};

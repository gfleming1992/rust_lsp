/**
 * Test API for webview tessellation rendering
 * 
 * Simulates VS Code extension API by:
 * 1. Intercepting postMessage calls from webview
 * 2. Loading corresponding <test_case_name>.bin from test data
 * 3. Decoding custom binary format with zero-copy TypedArray views
 * 4. Rendering to canvas for visual validation
 * 
 * Usage in HTML:
 *   <script>window.__TESSELLATION_TEST = 'layer_LAYER_Design';</script>
 *   <script src="/src/tests.ts" type="module"></script>
 */

import { parseBinaryLayer } from "./parsing";

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
  
  // Simulate initial extension startup message immediately (no delay)
  const startupMsg = {
    command: 'loadLayer',
    layerId: testCaseName,
    timestamp: Date.now()
  };
  handleTestMessage(startupMsg, testCaseName);
}

/**
 * Handle simulated message from "extension"
 * Loads JSON file and posts it back as if from extension
 */
async function handleTestMessage(message: unknown, testCaseName: string) {
  const msg = message as Record<string, unknown>;
  
  if (msg.command === 'loadLayer' || msg.command === 'getTessellation') {
    try {
      const startTime = performance.now();
      console.log(`[TEST] Loading tessellation data: ${testCaseName}`);
      
      // Use dynamic import with ?url suffix to get the file URL
      const modulePath = `./test-data/layer_${testCaseName}.bin?url`;
      
      console.log(`[TEST] Importing: ${modulePath}`);
      const fetchStart = performance.now();
      
      // Dynamic import returns the URL as default export
      const module = await import(/* @vite-ignore */ modulePath);
      const binaryUrl = module.default;
      
      const response = await fetch(binaryUrl);
      const fetchEnd = performance.now();
      
      if (!response.ok) {
        throw new Error(`Failed to fetch ${binaryUrl}: ${response.status} ${response.statusText}`);
      }
      
      // Decode custom binary format to LayerJSON
      const parseStart = performance.now();
      const arrayBuffer = await response.arrayBuffer();
      const layerJson = parseBinaryLayer(arrayBuffer);
      const parseEnd = performance.now();
      
      console.log(`[TEST] Successfully loaded layer in ${(parseEnd - startTime).toFixed(1)}ms (fetch: ${(fetchEnd - fetchStart).toFixed(1)}ms, parse: ${(parseEnd - parseStart).toFixed(1)}ms):`, layerJson);
      
      console.log(`[TEST] Decoded keys:`, Object.keys(layerJson));
      
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
 * Automatically discovers and loads all layer binary files from test-data directory
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
    
    // Load all layers in parallel for faster startup
    console.log(`[TEST] Loading ${testLayers.length} layers in parallel...`);
    await Promise.all(testLayers.map(layerName => {
        console.log(`[TEST] Loading layer: ${layerName}`);
        return Promise.resolve(initTestMode(layerName));
    }));
}

/**
 * Get list of available test cases from output directory
 */
export async function discoverTestLayers(): Promise<string[]> {
  // Hardcoded list of test layers - matches files in test-data directory
  return [
    'Board Dimensions',
    'Board Outline',
    'Bottom Layer',
    'Bottom Overlay',
    'Bottom Paste',
    'Bottom Solder',
    'Drill Drawing (Top Layer - Bottom Layer)',
    'Ground plane1',
    'Ground plane2',
    'Ground plane3',
    'Keep-Out Layer',
    'Mechanical 10',
    'Mechanical 14',
    'Mechanical 3',
    'Mechanical 4',
    'Mechanical 5',
    'Mechanical 9',
    'Power plane1',
    'Power plane2',
    'SELECTIVE PLATING BOTTOM',
    'Signal 1',
    'Signal 2',
    'Signal 3',
    'Top Layer',
    'Top Overlay',
    'Top Paste',
    'Top Solder',
  ];
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
    
    // Parse HTML directory listing - look for layer_*.bin files
    const binFiles = (text.match(/href="(layer_[^"]*\.bin)"/g) || [])
      .map(match => match.match(/href="([^"]*)"/)?.[1] || '')
      .map(filename => filename.replace('.bin', ''))
      .filter(Boolean)
      .sort();
    
    return binFiles;
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

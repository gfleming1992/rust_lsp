/**
 * Development server that mirrors VS Code extension behavior
 * - Spawns LSP server exactly like extension.ts
 * - Serves webview HTML with native ES modules
 * - WebSocket proxy for LSP communication
 * - Auto-reload on file changes via esbuild watch
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import chokidar from 'chokidar';

import fs from 'fs';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 5173;
const DEV_XML_PATH = path.join(__dirname, 'tests', 'NEX40400_PROBECARD_PCB.xml');

let lspServer = null;
let lspStdin = null;
const pendingRequests = new Map(); // id -> callback

// Start Express server
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Serve bundled output FIRST (higher priority)
app.use('/dist', express.static(path.join(__dirname, 'webview', 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve ONLY specific static files (CSS, assets), NOT .ts files
app.use(express.static(path.join(__dirname, 'webview'), {
  index: false, // Don't serve index.html from static
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  },
  // Only serve specific file types, block .ts files
  extensions: false
}));

// Serve index.html
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'assets', 'webview.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  const script = `
  <script>
    // Mock VS Code API for dev mode - MUST be defined before main.js loads
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) => {
        if (window.__devWs && window.__devWs.readyState === WebSocket.OPEN) {
          window.__devWs.send(JSON.stringify(msg));
        }
      }
    });
    
    // Connect to dev server WebSocket
    const ws = new WebSocket('ws://localhost:${PORT}');
    window.__devWs = ws;
    
    ws.onopen = () => {
      console.log('[DevServer] WebSocket connected');
      // Auto-load the hardcoded XML file
      ws.send(JSON.stringify({ command: 'Load', filePath: '${DEV_XML_PATH.replace(/\\/g, '\\\\')}' }));
    };
    
    ws.onmessage = (event) => {
      // Handle both text (JSON) and binary messages
      if (event.data instanceof ArrayBuffer) {
        // Binary message (ArrayBuffer) - forward as binary tessellation data
        console.log('[DevServer] Received binary WebSocket message:', event.data.byteLength, 'bytes');
        window.dispatchEvent(new MessageEvent('message', { 
          data: { command: 'binaryTessellationData', binaryPayload: event.data }
        }));
      } else if (event.data instanceof Blob) {
        // Binary message (Blob) - convert to ArrayBuffer first
        console.log('[DevServer] Received Blob WebSocket message:', event.data.size, 'bytes');
        event.data.arrayBuffer().then(buffer => {
          window.dispatchEvent(new MessageEvent('message', { 
            data: { command: 'binaryTessellationData', binaryPayload: buffer }
          }));
        });
      } else {
        // Text/JSON message
        const data = JSON.parse(event.data);
        
        if (data.type === 'reload') {
          console.log('[DevServer] File changed, reloading...');
          location.reload();
        } else {
          // Forward LSP messages to webview as postMessage events
          window.dispatchEvent(new MessageEvent('message', { data }));
        }
      }
    };
    
    ws.onerror = (error) => console.error('[DevServer] WebSocket error:', error);
    ws.onclose = () => console.log('[DevServer] WebSocket closed');
  </script>
  <script type="module" src="/dist/main.js"></script>`;

  html = html
    .replace('<!--CSP-->', '')
    .replace('<!--CSS-->', '')
    .replace('<!--SCRIPT-->', script);

  res.send(html);
});

// Start LSP server
function startLspServer() {
  // Try release first, fall back to debug
  const releasePath = path.join(__dirname, 'target', 'release', 'lsp_server.exe');
  const debugPath = path.join(__dirname, 'target', 'debug', 'lsp_server.exe');
  const serverPath = fs.existsSync(releasePath) ? releasePath : debugPath;
  
  console.log('[DevServer] Starting LSP server:', serverPath);
  
  lspServer = spawn(serverPath, [], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  lspStdin = lspServer.stdin;
  
  // Use readline to handle line-based JSON-RPC output
  const rl = readline.createInterface({
    input: lspServer.stdout,
    terminal: false
  });

  rl.on('line', (line) => {
    try {
      if (!line.trim()) return;
      
      // Check for binary response format: BINARY:<id>:<base64_data>
      if (line.startsWith('BINARY:')) {
        const parts = line.substring(7).split(':', 2); // Skip "BINARY:" prefix
        if (parts.length === 2) {
          const [id, base64Data] = parts;
          
          // Decode base64 to actual binary buffer
          const binaryData = Buffer.from(base64Data, 'base64');
          console.log(`[DevServer] Binary response for ID ${id}`);
          console.log(`[DevServer]   Base64 length: ${base64Data.length}, Binary size: ${binaryData.length} bytes`);
          console.log(`[DevServer]   First 32 bytes:`, binaryData.slice(0, 32));
          
          if (pendingRequests.has(id)) {
            const callback = pendingRequests.get(id);
            pendingRequests.delete(id);
            callback({ id, binaryData, isBinary: true });
          }
          return;
        }
      }
      
      // Standard JSON-RPC response
      const response = JSON.parse(line);
      
      // Check if this is a notification (no id or id is null) - like drcComplete
      if (response.method && (response.id === null || response.id === undefined)) {
        handleLspNotification(response);
        return;
      }
      
      // Check if this is a response to a pending request
      if (response.id && pendingRequests.has(response.id)) {
        const callback = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        callback(response);
      } else if (response.id) {
        console.warn('[DevServer] Received response for unknown ID:', response.id);
      }
    } catch (e) {
      console.error('[DevServer] Failed to parse LSP response:', e);
    }
  });
  
  lspServer.stderr.on('data', (data) => {
    console.log('[LSP Server]', data.toString().trim());
  });
  
  lspServer.on('exit', (code) => {
    console.log('[DevServer] LSP server exited with code:', code);
    lspServer = null;
    lspStdin = null;
  });
  
  console.log('[DevServer] LSP server started');
}

// Handle async notifications from LSP server (e.g., drcComplete)
function handleLspNotification(notification) {
  console.log('[DevServer] Received LSP notification:', notification.method);
  
  if (notification.method === 'drcComplete') {
    const result = notification.result;
    console.log(`[DevServer] Async DRC completed: ${result.region_count} regions in ${result.elapsed_ms?.toFixed(2)}ms`);
    
    // Broadcast to all connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({
          command: 'drcRegionsResult',
          regions: result.regions || [],
          elapsedMs: result.elapsed_ms || 0
        }));
      }
    });
  }
}

// Helper to send request to LSP
let requestIdCounter = 0;
function sendLspRequest(method, params, callback) {
  if (!lspStdin) return;
  
  const id = `req-${++requestIdCounter}`; // String ID to avoid float precision issues
  const request = { id, method, params };
  
  if (callback) {
    pendingRequests.set(id, callback);
  }
  
  lspStdin.write(JSON.stringify(request) + '\n');
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('[DevServer] Client connected');
  
  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());
    console.log('[DevServer] Received from client:', data.command);
    
    if (!lspServer || !lspStdin) {
      ws.send(JSON.stringify({ command: 'error', message: 'LSP server not running' }));
      return;
    }
    
    if (data.command === 'Load') {
      sendLspRequest('Load', { file_path: data.filePath || DEV_XML_PATH }, (response) => {
        if (response.error) {
          ws.send(JSON.stringify({ command: 'error', message: response.error.message }));
          return;
        }
        
        // After load, get layers
        sendLspRequest('GetLayers', null, (layersResponse) => {
          const layers = layersResponse.result || [];
          console.log(`[DevServer] Found ${layers.length} layers`);
          
          // Load all layers
          layers.forEach((layerId, index) => {
            // Use binary protocol for faster transfer
            sendLspRequest('GetTessellationBinary', { layer_id: layerId }, (tessResponse) => {
              if (tessResponse.isBinary) {
                // Send as binary WebSocket frame
                ws.send(tessResponse.binaryData);
              } else if (tessResponse.result) {
                // Fallback to JSON (shouldn't happen with GetTessellationBinary)
                ws.send(JSON.stringify({
                  command: 'tessellationData',
                  payload: tessResponse.result
                }));
              }
            });
          });
        });
      });
      
    } else if (data.command === 'GetLayers') {
      sendLspRequest('GetLayers', null, (response) => {
        ws.send(JSON.stringify({
          command: 'layerList',
          layers: response.result
        }));
      });
      
    } else if (data.command === 'GetTessellation') {
      // Support both binary and JSON requests
      const useBinary = data.useBinary !== false; // Default to binary
      const method = useBinary ? 'GetTessellationBinary' : 'GetTessellation';
      
      sendLspRequest(method, { layer_id: data.layerId }, (response) => {
        if (response.isBinary) {
          ws.send(response.binaryData);
        } else {
          ws.send(JSON.stringify({
            command: 'tessellationData',
            payload: response.result
          }));
        }
      });
      
    } else if (data.command === 'Select') {
      console.log(`[DevServer] Select at ${data.x}, ${data.y}`);
      sendLspRequest('Select', { x: data.x, y: data.y }, (response) => {
        if (response.result) {
          ws.send(JSON.stringify({
            command: 'selectionResult',
            ranges: response.result
          }));
        }
      });
      
    } else if (data.command === 'BoxSelect') {
      console.log(`[DevServer] BoxSelect: (${data.minX}, ${data.minY}) to (${data.maxX}, ${data.maxY})`);
      sendLspRequest('BoxSelect', { 
        min_x: data.minX, 
        min_y: data.minY, 
        max_x: data.maxX, 
        max_y: data.maxY 
      }, (response) => {
        if (response.result) {
          console.log(`[DevServer] BoxSelect returned ${response.result.length} objects`);
          ws.send(JSON.stringify({
            command: 'selectionResult',
            ranges: response.result
          }));
        }
      });
      
    } else if (data.command === 'Delete') {
      console.log(`[DevServer] Delete object:`, data.object);
      // TODO: Implement backend delete
      // For now, just acknowledge
      
    } else if (data.command === 'GetMemory') {
      // Forward get memory command to LSP server (don't log to reduce spam)
      sendLspRequest('GetMemory', null, (response) => {
        if (response.result) {
          ws.send(JSON.stringify({
            command: 'memoryResult',
            memoryBytes: response.result.memory_bytes
          }));
        }
      });
      
    } else if (data.command === 'UpdateLayerColor') {
      console.log(`[DevServer] UpdateLayerColor: ${data.layerId}`, data.color);
      sendLspRequest('UpdateLayerColor', { 
        layer_id: data.layerId, 
        color: data.color 
      }, (response) => {
        if (response.error) {
          console.error('[DevServer] UpdateLayerColor error:', response.error);
          ws.send(JSON.stringify({ command: 'error', message: response.error.message }));
        } else {
          console.log('[DevServer] UpdateLayerColor success');
        }
      });
      
    } else if (data.command === 'Save') {
      console.log('[DevServer] Save request');
      sendLspRequest('Save', data.filePath ? { file_path: data.filePath } : null, (response) => {
        if (response.error) {
          console.error('[DevServer] Save error:', response.error);
          ws.send(JSON.stringify({ 
            command: 'saveError', 
            error: response.error.message 
          }));
        } else if (response.result?.file_path) {
          console.log('[DevServer] Save success:', response.result.file_path);
          ws.send(JSON.stringify({ 
            command: 'saveComplete', 
            filePath: response.result.file_path 
          }));
        }
      });
      
    } else if (data.command === 'HighlightSelectedNets') {
      console.log(`[DevServer] HighlightSelectedNets for ${data.objectIds?.length || 0} objects`);
      sendLspRequest('HighlightSelectedNets', { object_ids: data.objectIds }, (response) => {
        if (response.result?.objects) {
          console.log(`[DevServer] HighlightSelectedNets returned ${response.result.objects.length} objects`);
          ws.send(JSON.stringify({
            command: 'highlightNetsResult',
            netNames: response.result.net_names,
            objects: response.result.objects
          }));
        }
      });
      
    } else if (data.command === 'HighlightSelectedComponents') {
      console.log(`[DevServer] HighlightSelectedComponents for ${data.objectIds?.length || 0} objects`);
      sendLspRequest('HighlightSelectedComponents', { object_ids: data.objectIds }, (response) => {
        if (response.result?.objects) {
          console.log(`[DevServer] HighlightSelectedComponents returned ${response.result.objects.length} objects`);
          ws.send(JSON.stringify({
            command: 'highlightComponentsResult',
            componentRefs: response.result.component_refs,
            objects: response.result.objects
          }));
        }
      });
      
    } else if (data.command === 'QueryNetAtPoint') {
      // Query net/component/pin at hover point for tooltip
      sendLspRequest('QueryNetAtPoint', { x: data.x, y: data.y }, (response) => {
        if (response.result) {
          ws.send(JSON.stringify({
            command: 'netAtPointResult',
            netName: response.result.net_name,
            componentRef: response.result.component_ref,
            pinRef: response.result.pin_ref,
            x: data.clientX,
            y: data.clientY
          }));
        }
      });
      
    } else if (data.command === 'RunDRCWithRegions') {
      console.log(`[DevServer] RunDRCWithRegions (clearance: ${data.clearance_mm || 0.15}mm)`);
      sendLspRequest('RunDRCWithRegions', { 
        clearance_mm: data.clearance_mm || 0.15,
        force_full: data.force_full || false
      }, (response) => {
        if (response.result?.status === 'started') {
          console.log('[DevServer] DRC started in background');
        } else if (response.error) {
          console.error('[DevServer] DRC error:', response.error);
          ws.send(JSON.stringify({
            command: 'drcRegionsResult',
            regions: [],
            error: response.error.message
          }));
        }
      });
    }
  });
  
  ws.on('close', () => {
    console.log('[DevServer] Client disconnected');
  });
});

// Start esbuild in watch mode
async function startEsbuild() {
  // Build the worker separately
  const workerCtx = await esbuild.context({
    entryPoints: ['webview/src/binaryParserWorker.ts'],
    bundle: true,
    outfile: 'webview/dist/binaryParserWorker.js',
    format: 'iife', // Workers need IIFE format
    sourcemap: true,
    target: 'es2020',
    logLevel: 'info',
  });
  
  await workerCtx.watch();
  
  // Build the main bundle
  const ctx = await esbuild.context({
    entryPoints: ['webview/src/main.ts'],
    bundle: true,
    outfile: 'webview/dist/main.js',
    format: 'esm',
    sourcemap: true,
    target: 'es2020',
    logLevel: 'info',
    loader: {
      '.wgsl': 'text', // Load WGSL shader files as text
    },
  });
  
  await ctx.watch();
  console.log('[DevServer] esbuild watching for changes...');
  
  // Watch for file changes and notify clients to reload
  const watcher = chokidar.watch('webview/src/**/*.ts', {
    ignored: /(^|[\/\\])\../,
    persistent: true
  });
  
  watcher.on('change', (filePath) => {
    console.log(`[DevServer] File changed: ${filePath}`);
    
    // Wait a bit for esbuild to finish rebuilding
    setTimeout(() => {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(JSON.stringify({ type: 'reload' }));
        }
      });
    }, 100);
  });
}

// Open browser (cross-platform)
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') {
    cmd = `start ${url}`;
  } else if (platform === 'darwin') {
    cmd = `open ${url}`;
  } else {
    cmd = `xdg-open ${url}`;
  }
  spawn(cmd, [], { shell: true, stdio: 'ignore' });
}

// Start everything
async function start() {
  startLspServer();
  await startEsbuild();
  
  httpServer.listen(PORT, () => {
    console.log(`\n[DevServer] Running at http://localhost:${PORT}`);
    console.log(`[DevServer] Loading XML: ${DEV_XML_PATH}\n`);
    
    // Auto-open browser after a short delay
    setTimeout(() => openBrowser(`http://localhost:${PORT}`), 500);
  });
}

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n[DevServer] Shutting down...');
  if (lspServer) {
    lspServer.kill();
  }
  process.exit(0);
});

start().catch(console.error);

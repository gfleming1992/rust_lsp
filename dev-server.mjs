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
  <script type="module" src="/dist/main.js"></script>
  <script>
    // Mock VS Code API for dev mode
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
      const data = JSON.parse(event.data);
      
      if (data.type === 'reload') {
        console.log('[DevServer] File changed, reloading...');
        location.reload();
      } else {
        // Forward LSP messages to webview as postMessage events
        window.dispatchEvent(new MessageEvent('message', { data }));
      }
    };
    
    ws.onerror = (error) => console.error('[DevServer] WebSocket error:', error);
    ws.onclose = () => console.log('[DevServer] WebSocket closed');
  </script>`;

  html = html
    .replace('<!--CSP-->', '')
    .replace('<!--CSS-->', '')
    .replace('<!--SCRIPT-->', script);

  res.send(html);
});

// Start LSP server
function startLspServer() {
  const serverPath = path.join(__dirname, 'target', 'release', 'lsp_server.exe');
  
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
      //console.log('[DevServer] Raw LSP output:', line.substring(0, 100) + '...');
      const response = JSON.parse(line);
      
      // Check if this is a response to a pending request
      if (response.id && pendingRequests.has(response.id)) {
        const callback = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        callback(response);
      } else {
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
            // Removed artificial delay
            sendLspRequest('GetTessellation', { layer_id: layerId }, (tessResponse) => {
              if (tessResponse.result) {
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
      sendLspRequest('GetTessellation', { layer_id: data.layerId }, (response) => {
        ws.send(JSON.stringify({
          command: 'tessellationData',
          payload: response.result
        }));
      });
    }
  });
  
  ws.on('close', () => {
    console.log('[DevServer] Client disconnected');
  });
});

// Start esbuild in watch mode
async function startEsbuild() {
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

// Start everything
async function start() {
  startLspServer();
  await startEsbuild();
  
  httpServer.listen(PORT, () => {
    console.log(`\n[DevServer] Running at http://localhost:${PORT}`);
    console.log(`[DevServer] Loading XML: ${DEV_XML_PATH}\n`);
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

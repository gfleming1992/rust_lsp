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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 5173;
const DEV_XML_PATH = path.join(__dirname, 'tests', 'pic_programmerB.xml');

let lspServer = null;
let lspStdout = null;
let lspStdin = null;

// Start Express server
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Serve static files from webview directory
app.use(express.static(path.join(__dirname, 'webview'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve bundled output
app.use('/dist', express.static(path.join(__dirname, 'webview', 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve index.html
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPC-2581 Viewer (Dev)</title>
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    #viewer { display: block; width: 100vw; height: 100vh; }
    #ui {
      position: fixed;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 10px;
      border-radius: 5px;
      font-family: monospace;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <canvas id="viewer"></canvas>
  <div id="ui">
    <div id="fps"></div>
    <div id="coordOverlay"></div>
    <div id="layers"></div>
  </div>
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
  </script>
</body>
</html>`);
});

// Start LSP server
function startLspServer() {
  const serverPath = path.join(__dirname, 'target', 'release', 'lsp_server.exe');
  
  console.log('[DevServer] Starting LSP server:', serverPath);
  
  lspServer = spawn(serverPath, [], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  lspStdin = lspServer.stdin;
  lspStdout = lspServer.stdout;
  
  lspServer.stderr.on('data', (data) => {
    console.log('[LSP Server]', data.toString().trim());
  });
  
  lspServer.on('exit', (code) => {
    console.log('[DevServer] LSP server exited with code:', code);
    lspServer = null;
    lspStdin = null;
    lspStdout = null;
  });
  
  console.log('[DevServer] LSP server started');
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('[DevServer] Client connected');
  
  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());
    console.log('[DevServer] Received from client:', data);
    
    if (!lspServer || !lspStdin || !lspStdout) {
      ws.send(JSON.stringify({ command: 'error', message: 'LSP server not running' }));
      return;
    }
    
    // Map client commands to LSP methods
    let lspRequest;
    
    if (data.command === 'Load') {
      lspRequest = {
        id: Date.now(),
        method: 'Load',
        params: { file_path: data.filePath || DEV_XML_PATH }
      };
    } else if (data.command === 'GetLayers') {
      lspRequest = {
        id: Date.now(),
        method: 'GetLayers',
        params: null
      };
    } else if (data.command === 'GetTessellation') {
      lspRequest = {
        id: Date.now(),
        method: 'GetTessellation',
        params: { layer_id: data.layerId }
      };
    } else {
      return;
    }
    
    // Send to LSP server
    lspStdin.write(JSON.stringify(lspRequest) + '\n');
    
    // Wait for response (simple implementation - assumes responses come back in order)
    lspStdout.once('data', (responseData) => {
      const response = JSON.parse(responseData.toString().trim());
      console.log('[DevServer] LSP response:', response);
      
      if (response.error) {
        ws.send(JSON.stringify({ command: 'error', message: response.error.message }));
        return;
      }
      
      // Map LSP responses to webview commands
      if (lspRequest.method === 'Load') {
        // After load, get layers
        const getLayersRequest = {
          id: Date.now(),
          method: 'GetLayers',
          params: null
        };
        
        lspStdin.write(JSON.stringify(getLayersRequest) + '\n');
        
        lspStdout.once('data', (layersData) => {
          const layersResponse = JSON.parse(layersData.toString().trim());
          const layers = layersResponse.result || [];
          
          console.log(`[DevServer] Found ${layers.length} layers`);
          
          // Load all layers
          layers.forEach((layerId, index) => {
            setTimeout(() => {
              const tessRequest = {
                id: Date.now(),
                method: 'GetTessellation',
                params: { layer_id: layerId }
              };
              
              lspStdin.write(JSON.stringify(tessRequest) + '\n');
              
              lspStdout.once('data', (tessData) => {
                const tessResponse = JSON.parse(tessData.toString().trim());
                
                if (tessResponse.result) {
                  ws.send(JSON.stringify({
                    command: 'tessellationData',
                    payload: tessResponse.result
                  }));
                }
              });
            }, index * 10); // Stagger requests slightly
          });
        });
        
      } else if (lspRequest.method === 'GetTessellation') {
        ws.send(JSON.stringify({
          command: 'tessellationData',
          payload: response.result
        }));
      }
    });
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

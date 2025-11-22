import { defineConfig } from "vite";
import { spawn, ChildProcess } from "child_process";
import path from "path";

let lspServer: ChildProcess | null = null;

// Hardcoded XML path for dev mode
const DEV_XML_PATH = path.resolve(__dirname, '../tests/pic_programmerB.xml');

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    hmr: {
      host: 'localhost',
      protocol: 'ws',
    }
  },
  build: {
    target: "es2020",
    outDir: '../dist/webview',
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'lsp-server',
      configureServer(server) {
        // Start LSP server when Vite starts
        const serverPath = path.resolve(__dirname, '../target/release/lsp_server.exe');
        console.log('[Vite] Starting LSP server:', serverPath);

        lspServer = spawn(serverPath, [], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!lspServer.stdout || !lspServer.stdin || !lspServer.stderr) {
          console.error('[Vite] Failed to start LSP server');
          return;
        }

        lspServer.stderr.on('data', (data) => {
          console.log('[LSP Server]', data.toString());
        });

        lspServer.on('exit', (code) => {
          console.log('[Vite] LSP server exited with code:', code);
          lspServer = null;
        });

        // Setup middleware to proxy webview messages to LSP server
        server.middlewares.use('/api/load', async (req, res) => {
          if (!lspServer || !lspServer.stdin || !lspServer.stdout) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'LSP server not running' }));
            return;
          }

          const request = { id: Date.now(), method: 'Load', params: { file_path: DEV_XML_PATH } };
          lspServer.stdin.write(JSON.stringify(request) + '\n');

          lspServer.stdout.once('data', (data) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(data.toString());
          });
        });

        server.middlewares.use('/api/layers', async (req, res) => {
          if (!lspServer || !lspServer.stdin || !lspServer.stdout) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'LSP server not running' }));
            return;
          }

          const request = { id: Date.now(), method: 'GetLayers', params: null };
          lspServer.stdin.write(JSON.stringify(request) + '\n');

          lspServer.stdout.once('data', (data) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(data.toString());
          });
        });

        server.middlewares.use('/api/tessellation', async (req, res) => {
          if (!lspServer || !lspServer.stdin || !lspServer.stdout) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'LSP server not running' }));
            return;
          }

          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            const { layerId } = JSON.parse(body);
            const request = { id: Date.now(), method: 'GetTessellation', params: { layer_id: layerId } };
            lspServer!.stdin!.write(JSON.stringify(request) + '\n');

            lspServer!.stdout!.once('data', (data) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(data.toString());
            });
          });
        });

        // Cleanup on server close
        server.httpServer?.on('close', () => {
          if (lspServer) {
            console.log('[Vite] Shutting down LSP server...');
            lspServer.kill();
            lspServer = null;
          }
        });
      }
    }
  ]
});

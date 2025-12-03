import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { handleWebviewMessage } from './extension/messageHandlers';

let lspServer: ChildProcess | null = null;
let requestId = 1;
let rl: readline.Interface | null = null;
const pendingRequests = new Map<string, { resolve: (response: any) => void, reject: (error: any) => void }>();

// Track active webview panel for async notifications
let activePanel: vscode.WebviewPanel | null = null;

// Rate-limited logging to prevent console spam during bulk operations
let logCount = 0;
let logWindowStart = Date.now();
const LOG_LIMIT = 50; // Max logs per window
const LOG_WINDOW_MS = 1000; // Window size in ms
let suppressedCount = 0;

function rateLimitedLog(...args: any[]) {
    const now = Date.now();
    // Reset window if expired
    if (now - logWindowStart > LOG_WINDOW_MS) {
        if (suppressedCount > 0) {
            console.log(`[Extension] ... (${suppressedCount} messages suppressed)`);
        }
        logWindowStart = now;
        logCount = 0;
        suppressedCount = 0;
    }
    
    if (logCount < LOG_LIMIT) {
        console.log(...args);
        logCount++;
    } else {
        suppressedCount++;
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[Extension] IPC-2581 Viewer activating...');

    // Start the Rust LSP server
    startLspServer(context);

    // Register the "Open PCB Layout" command
    const disposable = vscode.commands.registerCommand('ipc2581.openLayout', async (uri?: vscode.Uri) => {
        // If no URI provided, prompt the user to select a file
        if (!uri) {
            const files = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'IPC-2581 Files': ['xml'],
                    'All Files': ['*']
                },
                title: 'Select IPC-2581 XML File'
            });

            if (!files || files.length === 0) {
                return;
            }

            uri = files[0];
        }

        const filePath = uri.fsPath;
        console.log('[Extension] Opening PCB layout:', filePath);

        // Create webview panel
        const panel = vscode.window.createWebviewPanel(
            'ipc2581Viewer',
            `PCB: ${path.basename(filePath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(context.extensionPath, 'webview', 'dist'))
                ]
            }
        );
        
        // Track active panel for async notifications
        activePanel = panel;

        // Check if we are in development mode
        // const isDev = context.extensionMode === vscode.ExtensionMode.Development;
        const isDev = false; // FORCE PROD MODE to load built files from disk

        if (isDev) {
            // DEV MODE: Load from Vite server at localhost:5173
            panel.webview.html = getDevHtml(context.extensionPath);
        } else {
            // PROD MODE: Load built assets from disk
            panel.webview.html = getProdHtml(panel.webview, context.extensionUri, context.extensionPath);
        }

        // Handle messages from webview - delegated to extracted handler
        panel.webview.onDidReceiveMessage(
            (message) => handleWebviewMessage(message, panel, filePath, sendToLspServer, rateLimitedLog),
            undefined,
            context.subscriptions
        );

        // Note: With retainContextWhenHidden: true, the webview state is preserved
        // when switching tabs, so we don't need to reload the file.
        // The LSP server keeps the state (including deleted_objects) intact.

        // Clean up LSP server memory when webview is closed
        panel.onDidDispose(() => {
            console.log('[Extension] Webview disposed, cleaning up LSP server state');
            activePanel = null;
            sendCloseToLspServer();
        }, null, context.subscriptions);
    });

    context.subscriptions.push(disposable);

    console.log('[Extension] IPC-2581 Viewer activated');
}

export function deactivate() {
    console.log('[Extension] IPC-2581 Viewer deactivating...');
    if (lspServer) {
        lspServer.kill();
        lspServer = null;
    }
}

function startLspServer(context: vscode.ExtensionContext) {
    const serverName = process.platform === 'win32' ? 'lsp_server.exe' : 'lsp_server';
    // Look for binary in target/release/ (Cargo's default output)
    const serverPath = path.join(context.extensionPath, 'target', 'release', serverName);
    
    console.log('[Extension] Starting LSP server:', serverPath);

    lspServer = spawn(serverPath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!lspServer.stdout || !lspServer.stdin) {
        vscode.window.showErrorMessage('Failed to start IPC-2581 LSP server');
        return;
    }

    // Use readline to handle line-based JSON-RPC output
    rl = readline.createInterface({
        input: lspServer.stdout,
        terminal: false
    });

    rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
            // Check for binary response format: BINARY:<id>:<base64_data>
            if (line.startsWith('BINARY:')) {
                // The format is BINARY:ID:DATA
                const firstColon = line.indexOf(':', 7);
                if (firstColon > -1) {
                    const id = line.substring(7, firstColon);
                    const base64Data = line.substring(firstColon + 1);
                    
                    const binaryData = Buffer.from(base64Data, 'base64');
                    console.log(`[Extension] Binary response for ID ${id}`);
                    console.log(`[Extension]   Base64 length: ${base64Data.length}, Binary size: ${binaryData.length} bytes`);
                    console.log(`[Extension]   First 16 bytes:`, Array.from(binaryData.slice(0, 16)));
                    
                    const pending = pendingRequests.get(id);
                    if (pending) {
                        pendingRequests.delete(id);
                        pending.resolve({ id, binaryData, isBinary: true });
                    } else {
                        console.warn(`[Extension] No pending request found for binary ID ${id}`);
                    }
                    return;
                }
            }

            // Skip lines that don't look like JSON (probably stderr leaking)
            if (!line.startsWith('{') && !line.startsWith('[')) {
                return;
            }

            // Standard JSON-RPC response
            const response = JSON.parse(line);
            
            // Check if this is an async notification (id is null, has method field)
            if (response.id === null && response.method) {
                handleLspNotification(response);
                return;
            }
            
            const pending = pendingRequests.get(String(response.id));
            if (pending) {
                pendingRequests.delete(String(response.id));
                pending.resolve(response);
            }
        } catch (e) {
            console.error('[Extension] Failed to parse LSP response:', e);
        }
    });

    // Log stderr (Rust uses eprintln! for logging)
    lspServer.stderr?.on('data', (data) => {
        console.log('[LSP Server]', data.toString());
    });

    lspServer.on('exit', (code) => {
        console.log('[Extension] LSP server exited with code:', code);
        lspServer = null;
        rl = null;
    });

    console.log('[Extension] LSP server started');
}

// Handle async notifications from LSP server
function handleLspNotification(notification: any) {
    console.log('[Extension] Received LSP notification:', notification.method);
    
    if (notification.method === 'drcComplete' && activePanel) {
        const result = notification.result;
        console.log(`[Extension] Async DRC completed: ${result.region_count} regions in ${result.elapsed_ms?.toFixed(2)}ms`);
        
        activePanel.webview.postMessage({
            command: 'drcRegionsResult',
            regions: result.regions || [],
            elapsedMs: result.elapsed_ms || 0
        });
    }
}

async function sendToLspServer(request: { method: string; params: any }, panel: vscode.WebviewPanel): Promise<any> {
    if (!lspServer || !lspServer.stdin) {
        vscode.window.showErrorMessage('LSP server is not running');
        return null;
    }

    const id = String(requestId++);
    const jsonRequest = JSON.stringify({ id, ...request }) + '\n';

    // Suppress logging for frequent polling requests
    if (request.method !== 'GetMemory') {
        rateLimitedLog('[Extension] Sending to LSP server:', jsonRequest.trim());
    }

    // Create promise for response with timeout
    const responsePromise = new Promise<any>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        
        // Add 30 second timeout
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(`Timeout waiting for LSP response (id: ${id}, method: ${request.method})`));
            }
        }, 30000);
    });

    // Write request to LSP server stdin
    try {
        lspServer.stdin.write(jsonRequest);
    } catch (writeError) {
        console.error('[Extension] Failed to write to LSP stdin:', writeError);
        pendingRequests.delete(id);
        throw writeError;
    }

    try {
        const response = await responsePromise;

        if (response.error) {
            vscode.window.showErrorMessage(`LSP Error: ${response.error.message}`);
            return response;
        }

        // Forward response to webview
        if (request.method === 'GetLayers') {
            const layers = response.result || [];
            
            // Send layer count first
            panel.webview.postMessage({
                command: 'layerCount',
                count: layers.length
            });
            
            // Then request binary tessellation for each layer
            for (const layerId of layers) {
                sendBinaryTessellation(layerId, panel);
            }
        } else if (request.method === 'Load') {
            // After load, automatically get layers
            sendToLspServer({ method: 'GetLayers', params: null }, panel);
        } else if (request.method === 'Delete' && response.result?.related_objects) {
            // Forward related objects to webview (for via multi-layer deletion)
            const relatedObjects = response.result.related_objects;
            if (relatedObjects.length > 0) {
                panel.webview.postMessage({
                    command: 'deleteRelatedObjects',
                    objects: relatedObjects
                });
            }
        }
        
        return response;
    } catch (error) {
        console.error('[Extension] LSP request failed:', error);
        return null;
    }
}

async function sendBinaryTessellation(layerId: string, panel: vscode.WebviewPanel) {
    if (!lspServer || !lspServer.stdin) {
        return;
    }

    const id = String(requestId++);
    const jsonRequest = JSON.stringify({ 
        id, 
        method: 'GetTessellationBinary', 
        params: { layer_id: layerId } 
    }) + '\n';

    const responsePromise = new Promise<any>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
    });

    lspServer.stdin.write(jsonRequest);

    try {
        const response = await responsePromise;
        
        if (response.isBinary) {
            // Send binary data as Uint8Array - VS Code webview can handle this
            // The webview will receive it and can create an ArrayBuffer from it
            const uint8Array = new Uint8Array(response.binaryData);
            
            panel.webview.postMessage({
                command: 'binaryTessellationData',
                binaryPayload: uint8Array
            });
        }
    } catch (error) {
        console.error('[Extension] Binary tessellation failed:', error);
    }
}

// Send Close message to LSP server to free memory (fire-and-forget)
function sendCloseToLspServer() {
    if (!lspServer || !lspServer.stdin) {
        return;
    }

    const id = String(requestId++);
    const jsonRequest = JSON.stringify({ 
        id, 
        method: 'Close', 
        params: null 
    }) + '\n';

    try {
        lspServer.stdin.write(jsonRequest);
        console.log('[Extension] Sent Close command to LSP server');
    } catch (error) {
        console.error('[Extension] Failed to send Close command:', error);
    }
}

function getDevHtml(extensionPath: string): string {
    const htmlPath = path.join(extensionPath, 'assets', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const csp = `
        default-src 'none';
        img-src * 'self' data: https:;
        script-src 'unsafe-inline' 'unsafe-eval' http://localhost:5173;
        style-src 'unsafe-inline' http://localhost:5173;
        connect-src ws://localhost:5173 http://localhost:5173;
    `;

    const script = `<script type="module" src="http://localhost:5173/dist/main.js"></script>`;

    return html
        .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace('<!--CSS-->', '')
        .replace('<!--SCRIPT-->', script);
}

function getProdHtml(webview: vscode.Webview, extensionUri: vscode.Uri, extensionPath: string): string {
    const webviewPath = vscode.Uri.joinPath(extensionUri, 'webview', 'dist');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'main.js'));
    
    // Read worker file content
    const workerPath = path.join(extensionPath, 'webview', 'dist', 'binaryParserWorker.js');
    let workerContent = '';
    try {
        workerContent = fs.readFileSync(workerPath, 'utf-8');
    } catch (e) {
        console.error('[Extension] Failed to read worker file:', e);
    }
    
    const htmlPath = path.join(extensionPath, 'assets', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const csp = `
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src ${webview.cspSource} 'unsafe-inline';
        worker-src ${webview.cspSource} blob:;
    `;

    return html
        .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace('<!--CSS-->', '')
        .replace('<!--SCRIPT-->', `
            <script id="worker-source" type="javascript/worker">
                ${workerContent}
            </script>
            <script src="${scriptUri}"></script>
        `);
}

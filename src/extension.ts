import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';

let lspServer: ChildProcess | null = null;
let requestId = 1;
let rl: readline.Interface | null = null;
const pendingRequests = new Map<string, { resolve: (response: any) => void, reject: (error: any) => void }>();

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

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                // Forward console logs from webview
                if (message.command?.startsWith('console.')) {
                    const level = message.command.substring(8);
                    const args = message.args || [];
                    console.log(`[Webview ${level}]`, ...args);
                    return;
                }

                console.log('[Extension] Received message from webview:', message);

                switch (message.command) {
                    case 'ready':
                        // Webview is ready (initial load or moved to new window)
                        console.log('[Extension] Webview ready, loading file:', filePath);
                        await sendToLspServer({ method: 'Load', params: { file_path: filePath } }, panel);
                        break;
                    case 'Load':
                        await sendToLspServer({ method: 'Load', params: { file_path: filePath } }, panel);
                        break;
                    case 'GetLayers':
                        await sendToLspServer({ method: 'GetLayers', params: null }, panel);
                        break;
                    case 'GetTessellation':
                        await sendToLspServer({ method: 'GetTessellation', params: { layer_id: message.layerId } }, panel);
                        break;
                    case 'UpdateLayerColor':
                        await sendToLspServer({ 
                            method: 'UpdateLayerColor', 
                            params: { 
                                layer_id: message.layerId, 
                                color: message.color 
                            } 
                        }, panel);
                        break;
                    case 'Save':
                        console.log('[Extension] Received Save command from webview');
                        try {
                            console.log('[Extension] Calling sendToLspServer for Save...');
                            const saveResponse = await sendToLspServer({ 
                                method: 'Save', 
                                params: message.filePath ? { file_path: message.filePath } : null 
                            }, panel);
                            
                            console.log('[Extension] Save response:', saveResponse);
                            
                            if (saveResponse?.result?.file_path) {
                                const filePath = saveResponse.result.file_path;
                                console.log('[Extension] Save successful:', filePath);
                                vscode.window.showInformationMessage(`PCB saved to: ${filePath}`);
                                
                                // Send confirmation back to webview
                                panel.webview.postMessage({ 
                                    command: 'saveComplete', 
                                    filePath: filePath 
                                });
                            } else if (saveResponse?.error) {
                                console.error('[Extension] Save error from LSP:', saveResponse.error);
                                vscode.window.showErrorMessage(`Save failed: ${saveResponse.error.message}`);
                                panel.webview.postMessage({ 
                                    command: 'saveError', 
                                    error: saveResponse.error.message 
                                });
                            } else {
                                console.error('[Extension] Save failed: No valid response');
                                vscode.window.showErrorMessage('Save failed: No response from LSP server');
                                panel.webview.postMessage({ 
                                    command: 'saveError', 
                                    error: 'No response from LSP server' 
                                });
                            }
                        } catch (error) {
                            console.error('[Extension] Save exception:', error);
                            const errorMsg = error instanceof Error ? error.message : String(error);
                            vscode.window.showErrorMessage(`Save failed: ${errorMsg}`);
                            panel.webview.postMessage({ 
                                command: 'saveError', 
                                error: errorMsg 
                            });
                        }
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        // Handle panel state changes (e.g., moved to new window)
        panel.onDidChangeViewState(() => {
            if (panel.visible) {
                console.log('[Extension] Panel became visible, re-triggering load');
                setTimeout(() => {
                    sendToLspServer({ method: 'Load', params: { file_path: filePath } }, panel);
                }, 100);
            }
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
    const serverPath = path.join(context.extensionPath, 'bin', 'lsp_server.exe');
    
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

async function sendToLspServer(request: { method: string; params: any }, panel: vscode.WebviewPanel): Promise<any> {
    if (!lspServer || !lspServer.stdin) {
        vscode.window.showErrorMessage('LSP server is not running');
        return null;
    }

    const id = String(requestId++);
    const jsonRequest = JSON.stringify({ id, ...request }) + '\n';

    console.log('[Extension] Sending to LSP server:', jsonRequest.trim());

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
        const writeSuccess = lspServer.stdin.write(jsonRequest);
        console.log('[Extension] Write to LSP stdin:', writeSuccess ? 'success' : 'buffered');
    } catch (writeError) {
        console.error('[Extension] Failed to write to LSP stdin:', writeError);
        pendingRequests.delete(id);
        throw writeError;
    }

    try {
        console.log('[Extension] Awaiting response for id:', id);
        const response = await responsePromise;
        console.log('[Extension] Received response for id:', id, 'method:', request.method);

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
            // Send binary data as ArrayBuffer to webview
            // Convert Node.js Buffer to ArrayBuffer (webview can't use Buffer directly)
            const arrayBuffer = response.binaryData.buffer.slice(
                response.binaryData.byteOffset,
                response.binaryData.byteOffset + response.binaryData.byteLength
            );
            
            panel.webview.postMessage({
                command: 'binaryTessellationData',
                binaryPayload: arrayBuffer
            });
        }
    } catch (error) {
        console.error('[Extension] Binary tessellation failed:', error);
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

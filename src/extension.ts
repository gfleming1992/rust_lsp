import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

let lspServer: ChildProcess | null = null;
let requestId = 1;

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
                    vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview'))
                ]
            }
        );

        // Check if we are in development mode
        const isDev = context.extensionMode === vscode.ExtensionMode.Development;

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
                console.log('[Extension] Received message from webview:', message);

                switch (message.command) {
                    case 'Load':
                        await sendToLspServer({ method: 'Load', params: { file_path: filePath } }, panel);
                        break;
                    case 'GetLayers':
                        await sendToLspServer({ method: 'GetLayers', params: null }, panel);
                        break;
                    case 'GetTessellation':
                        await sendToLspServer({ method: 'GetTessellation', params: { layer_id: message.layerId } }, panel);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        // Automatically load the file when the panel opens
        setTimeout(() => {
            sendToLspServer({ method: 'Load', params: { file_path: filePath } }, panel);
        }, 100);
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

    // Log stderr (Rust uses eprintln! for logging)
    lspServer.stderr?.on('data', (data) => {
        console.log('[LSP Server]', data.toString());
    });

    lspServer.on('exit', (code) => {
        console.log('[Extension] LSP server exited with code:', code);
        lspServer = null;
    });

    console.log('[Extension] LSP server started');
}

async function sendToLspServer(request: { method: string; params: any }, panel: vscode.WebviewPanel) {
    if (!lspServer || !lspServer.stdin || !lspServer.stdout) {
        vscode.window.showErrorMessage('LSP server is not running');
        return;
    }

    const id = requestId++;
    const jsonRequest = JSON.stringify({ id, ...request }) + '\n';

    console.log('[Extension] Sending to LSP server:', jsonRequest.trim());

    // Write request to LSP server stdin
    lspServer.stdin.write(jsonRequest);

    // Read response from LSP server stdout
    lspServer.stdout.once('data', (data) => {
        const response = JSON.parse(data.toString().trim());
        console.log('[Extension] Received from LSP server:', response);

        if (response.error) {
            vscode.window.showErrorMessage(`LSP Error: ${response.error.message}`);
            return;
        }

        // Forward response to webview
        if (request.method === 'GetLayers') {
            panel.webview.postMessage({
                command: 'layerList',
                layers: response.result
            });
        } else if (request.method === 'GetTessellation') {
            panel.webview.postMessage({
                command: 'tessellationData',
                payload: response.result
            });
        } else if (request.method === 'Load') {
            // After load, automatically get layers
            sendToLspServer({ method: 'GetLayers', params: null }, panel);
        }
    });
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
    const webviewPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'index.css'));
    
    const htmlPath = path.join(extensionPath, 'assets', 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const csp = `
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src ${webview.cspSource};
    `;

    return html
        .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace('<!--CSS-->', `<link href="${styleUri}" rel="stylesheet">`)
        .replace('<!--SCRIPT-->', `<script type="module" src="${scriptUri}"></script>`);
}

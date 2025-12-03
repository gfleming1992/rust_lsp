/** Sets up the debug console overlay for the dev server (not VS Code) */
export function setupDevConsole() {
  const debugConsole = document.createElement('div');
  debugConsole.id = 'debug-console';
  debugConsole.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 300px;
    background: rgba(30, 30, 30, 0.95);
    color: #d4d4d4;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 12px;
    overflow-y: auto;
    padding: 8px;
    border-top: 2px solid #007acc;
    z-index: 10000;
    display: flex;
    flex-direction: column;
  `;
  
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 4px;
    border-bottom: 1px solid #555;
    margin-bottom: 4px;
    flex-shrink: 0;
  `;
  header.innerHTML = `
    <span style="font-weight: bold; color: #007acc;">[Dev Server Debug Console]</span>
    <button id="clear-console" style="
      background: #007acc;
      color: white;
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 11px;
      border-radius: 3px;
    ">Clear</button>
  `;
  
  const logContainer = document.createElement('div');
  logContainer.id = 'log-container';
  logContainer.style.cssText = 'flex: 1; overflow-y: auto;';
  
  debugConsole.appendChild(header);
  debugConsole.appendChild(logContainer);
  document.body.appendChild(debugConsole);
  
  const clearButton = document.getElementById('clear-console');
  clearButton?.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });
  
  const addLogEntry = (type: string, args: any[]) => {
    const entry = document.createElement('div');
    entry.style.cssText = 'padding: 2px 0; border-bottom: 1px solid #333;';
    
    const typeColors: Record<string, string> = {
      log: '#d4d4d4',
      error: '#f48771',
      warn: '#dcdcaa',
      info: '#4fc1ff'
    };
    
    const timestamp = new Date().toISOString().substring(11, 23);
    const color = typeColors[type] || '#d4d4d4';
    
    const formattedArgs = args.map(arg => {
      if (typeof arg === 'object') {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    }).join(' ');
    
    entry.innerHTML = `<span style="color: #858585;">[${timestamp}]</span> <span style="color: ${color};">${formattedArgs}</span>`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  };
  
  // Store originals and intercept console methods
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  
  console.log = (...args: any[]) => {
    addLogEntry('log', args);
    originalLog.apply(console, args);
  };
  
  console.error = (...args: any[]) => {
    addLogEntry('error', args);
    originalError.apply(console, args);
  };
  
  console.warn = (...args: any[]) => {
    addLogEntry('warn', args);
    originalWarn.apply(console, args);
  };
  
  console.info = (...args: any[]) => {
    addLogEntry('info', args);
    originalInfo.apply(console, args);
  };
}

/** Sets up console forwarding to VS Code extension host */
export function setupVSCodeConsoleForwarding(vscode: any) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  const serializeArgs = (args: any[]) => args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
    }
    return arg;
  });

  console.log = (...args) => {
    vscode.postMessage({ command: 'console.log', args: serializeArgs(args) });
    originalLog.apply(console, args);
  };
  
  console.error = (...args) => {
    vscode.postMessage({ command: 'console.error', args: serializeArgs(args) });
    originalError.apply(console, args);
  };
  
  console.warn = (...args) => {
    vscode.postMessage({ command: 'console.warn', args: serializeArgs(args) });
    originalWarn.apply(console, args);
  };
  
  console.info = (...args) => {
    vscode.postMessage({ command: 'console.info', args: serializeArgs(args) });
    originalInfo.apply(console, args);
  };
}

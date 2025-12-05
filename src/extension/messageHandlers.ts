import * as vscode from 'vscode';

export type SendToLspServer = (request: { method: string; params: any }, panel: vscode.WebviewPanel) => Promise<any>;

/** Handles webview messages and forwards them to LSP server */
export async function handleWebviewMessage(
  message: any,
  panel: vscode.WebviewPanel,
  filePath: string,
  sendToLspServer: SendToLspServer,
  rateLimitedLog: (...args: any[]) => void
): Promise<void> {
  // Forward console logs from webview
  if (message.command?.startsWith('console.')) {
    const level = message.command.substring(8);
    console.log(`[Webview ${level}]`, ...(message.args || []));
    return;
  }

  // Filter out high-frequency polling messages from debug console
  if (message.command !== 'GetMemory') {
    rateLimitedLog('[Extension] Received message from webview:', message);
  }

  switch (message.command) {
    case 'ready':
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
        params: { layer_id: message.layerId, color: message.color } 
      }, panel);
      break;

    case 'Select':
      await handleSelect(message, panel, sendToLspServer);
      break;

    case 'Save':
      await handleSave(message, panel, sendToLspServer);
      break;

    case 'Delete':
      await sendToLspServer({ method: 'Delete', params: { object: message.object } }, panel);
      break;

    case 'SetLayerVisibility':
      await sendToLspServer({ 
        method: 'SetLayerVisibility', 
        params: { layer_id: message.layerId, visible: message.visible } 
      }, panel);
      break;

    case 'Undo':
      await sendToLspServer({ method: 'Undo', params: { object: message.object } }, panel);
      break;

    case 'Redo':
      await sendToLspServer({ method: 'Redo', params: { object: message.object } }, panel);
      break;

    case 'MoveObjects':
      await handleMoveObjects(message, panel, sendToLspServer);
      break;

    case 'RotateObjects':
      await handleRotateObjects(message, panel, sendToLspServer);
      break;

    case 'UndoMove':
      console.log('[Extension] Received UndoMove command');
      await sendToLspServer({ 
        method: 'UndoMove', 
        params: { object_ids: message.objectIds, delta_x: message.deltaX, delta_y: message.deltaY } 
      }, panel);
      break;

    case 'RedoMove':
      console.log('[Extension] Received RedoMove command');
      await sendToLspServer({ 
        method: 'RedoMove', 
        params: { object_ids: message.objectIds, delta_x: message.deltaX, delta_y: message.deltaY } 
      }, panel);
      break;

    case 'BoxSelect':
      await handleBoxSelect(message, panel, sendToLspServer);
      break;

    case 'CheckPointHitsSelection':
      await handleCheckPointHitsSelection(message, panel, sendToLspServer);
      break;

    case 'HighlightSelectedNets':
      await handleHighlightSelectedNets(message, panel, sendToLspServer);
      break;

    case 'HighlightSelectedComponents':
      await handleHighlightSelectedComponents(message, panel, sendToLspServer);
      break;

    case 'QueryNetAtPoint':
      await handleQueryNetAtPoint(message, panel, sendToLspServer);
      break;

    case 'GetMemory':
      await handleGetMemory(panel, sendToLspServer);
      break;

    case 'RunDRCWithRegions':
      await handleRunDRC(message, panel, sendToLspServer);
      break;
  }
}

async function handleSelect(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'Select', 
    params: { x: message.x, y: message.y } 
  }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({ command: 'selectionResult', ranges: response.result });
  }
}

async function handleSave(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  console.log('[Extension] Received Save command from webview');
  try {
    const response = await sendToLspServer({ 
      method: 'Save', 
      params: message.filePath ? { file_path: message.filePath } : null 
    }, panel);
    
    if (response?.result?.file_path) {
      console.log('[Extension] Save successful:', response.result.file_path);
      vscode.window.showInformationMessage(`PCB saved to: ${response.result.file_path}`);
      panel.webview.postMessage({ command: 'saveComplete', filePath: response.result.file_path });
    } else if (response?.error) {
      console.error('[Extension] Save error from LSP:', response.error);
      vscode.window.showErrorMessage(`Save failed: ${response.error.message}`);
      panel.webview.postMessage({ command: 'saveError', error: response.error.message });
    } else {
      vscode.window.showErrorMessage('Save failed: No response from LSP server');
      panel.webview.postMessage({ command: 'saveError', error: 'No response from LSP server' });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Save failed: ${errorMsg}`);
    panel.webview.postMessage({ command: 'saveError', error: errorMsg });
  }
}

async function handleMoveObjects(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  console.log('[Extension] Received MoveObjects command:', message.objectIds?.length, 'objects');
  const response = await sendToLspServer({ 
    method: 'MoveObjects', 
    params: { object_ids: message.objectIds, delta_x: message.deltaX, delta_y: message.deltaY } 
  }, panel);
  
  if (response?.result) {
    console.log('[Extension] MoveObjects success:', response.result.moved_count, 'objects moved');
    panel.webview.postMessage({ command: 'moveComplete', movedCount: response.result.moved_count });
  } else if (response?.error) {
    console.error('[Extension] MoveObjects error:', response.error);
    panel.webview.postMessage({ command: 'moveError', error: response.error.message });
  }
}

async function handleRotateObjects(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  console.log('[Extension] Received RotateObjects command:', message.objectIds?.length, 'objects, delta:', message.rotationDelta);
  const response = await sendToLspServer({ 
    method: 'RotateObjects', 
    params: { 
      object_ids: message.objectIds, 
      rotation_delta: message.rotationDelta,
      component_center: message.componentCenter,
      per_object_offsets: message.perObjectOffsets
    } 
  }, panel);
  
  if (response?.result) {
    console.log('[Extension] RotateObjects success:', response.result.rotated_count, 'objects rotated');
    panel.webview.postMessage({ command: 'rotateComplete', rotatedCount: response.result.rotated_count });
  } else if (response?.error) {
    console.error('[Extension] RotateObjects error:', response.error);
    panel.webview.postMessage({ command: 'rotateError', error: response.error.message });
  }
}

async function handleBoxSelect(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'BoxSelect', 
    params: { min_x: message.minX, min_y: message.minY, max_x: message.maxX, max_y: message.maxY } 
  }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({ command: 'selectionResult', ranges: response.result });
  }
}

async function handleCheckPointHitsSelection(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'CheckPointHitsSelection', 
    params: { x: message.x, y: message.y, object_ids: message.objectIds } 
  }, panel);
  
  if (response?.result !== undefined) {
    panel.webview.postMessage({
      command: 'checkPointHitsSelectionResult',
      requestId: message.requestId,
      hits: response.result
    });
  }
}

async function handleHighlightSelectedNets(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'HighlightSelectedNets', 
    params: { object_ids: message.objectIds } 
  }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({
      command: 'highlightNetsResult',
      netNames: response.result.net_names,
      objects: response.result.objects
    });
  }
}

async function handleHighlightSelectedComponents(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'HighlightSelectedComponents', 
    params: { object_ids: message.objectIds } 
  }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({
      command: 'highlightComponentsResult',
      componentRefs: response.result.component_refs,
      objects: response.result.objects
    });
  }
}

async function handleQueryNetAtPoint(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ 
    method: 'QueryNetAtPoint', 
    params: { x: message.x, y: message.y } 
  }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({
      command: 'netAtPointResult',
      netName: response.result.net_name,
      componentRef: response.result.component_ref,
      pinRef: response.result.pin_ref,
      x: message.clientX,
      y: message.clientY
    });
  }
}

async function handleGetMemory(panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  const response = await sendToLspServer({ method: 'GetMemory', params: null }, panel);
  
  if (response?.result) {
    panel.webview.postMessage({
      command: 'memoryResult',
      memoryBytes: response.result.memory_bytes
    });
  }
}

async function handleRunDRC(message: any, panel: vscode.WebviewPanel, sendToLspServer: SendToLspServer) {
  console.log('[Extension] Starting async DRC...');
  // Only pass clearance_mm if explicitly provided; otherwise let LSP use file's design rules
  const params: { force_full?: boolean; clearance_mm?: number } = {};
  if (message.force_full !== undefined) params.force_full = message.force_full;
  if (message.clearance_mm !== undefined) params.clearance_mm = message.clearance_mm;
  
  const response = await sendToLspServer({ 
    method: 'RunDRCWithRegions', 
    params 
  }, panel);
  
  if (response?.result?.status === 'started') {
    console.log('[Extension] DRC started in background');
  } else if (response?.error) {
    console.error('[Extension] DRC error:', response.error);
    panel.webview.postMessage({
      command: 'drcRegionsResult',
      regions: [],
      error: response.error.message
    });
  }
}

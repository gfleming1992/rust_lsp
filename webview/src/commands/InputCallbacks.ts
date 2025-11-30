/**
 * InputCallbacks - Sets up input event handlers connected to the API
 * 
 * This centralizes the connection between user input events and API commands.
 */

import { Scene } from "../Scene";
import { UI } from "../UI";
import { Input } from "../Input";
import { IApiClient } from "../api/types";
import { SelectionState } from "./CommandHandler";

export interface InputCallbacksDeps {
    scene: Scene;
    ui: UI;
    input: Input;
    api: IApiClient;
    selectionState: SelectionState;
}

/**
 * Creates the onSelect callback for Input constructor
 */
export function createOnSelectCallback(
    api: IApiClient,
    selectionState: SelectionState
): (x: number, y: number, ctrlKey: boolean) => void {
    return (x, y, ctrlKey) => {
        selectionState.isBoxSelect = false;
        selectionState.isCtrlSelect = ctrlKey;
        api.send({ command: 'Select', x, y });
        if (ctrlKey) {
            console.log(`[Select] at ${x}, ${y} (Ctrl+click, append mode)`);
        }
    };
}

/**
 * Sets up all the input callbacks that send commands to the backend
 * (called after Input is constructed)
 */
export function setupInputCallbacks(deps: InputCallbacksDeps): void {
    const { scene, ui, input, api, selectionState } = deps;
    
    // Box select handler
    input.setOnBoxSelect((minX, minY, maxX, maxY) => {
        selectionState.isBoxSelect = true;
        api.send({ command: 'BoxSelect', minX, minY, maxX, maxY });
    });
    
    // Highlight nets handler
    input.setOnHighlightNets(() => {
        if (selectionState.selectedObjects.length === 0) {
            console.log('[HighlightNets] No objects selected');
            return;
        }
        
        const objectIds = selectionState.selectedObjects.map(obj => obj.id);
        console.log(`[HighlightNets] Requesting nets for ${objectIds.length} selected object(s)`);
        api.send({ command: 'HighlightSelectedNets', objectIds });
    });
    
    // Highlight components handler
    input.setOnHighlightComponents(() => {
        if (selectionState.selectedObjects.length === 0) {
            console.log('[HighlightComponents] No objects selected');
            return;
        }
        
        const objectIds = selectionState.selectedObjects.map(obj => obj.id);
        console.log(`[HighlightComponents] Requesting components for ${objectIds.length} selected object(s)`);
        api.send({ command: 'HighlightSelectedComponents', objectIds });
    });
    
    // Net tooltip query handler
    input.setOnQueryNetAtPoint((worldX, worldY, clientX, clientY) => {
        api.send({ command: 'QueryNetAtPoint', x: worldX, y: worldY, clientX, clientY });
    });
    
    // Show only selected net layers handler
    input.setOnShowOnlySelectedNetLayers(() => {
        const objectsToUse = selectionState.lastNetHighlightAllObjects.length > 0 
            ? selectionState.lastNetHighlightAllObjects 
            : selectionState.selectedObjects;
        
        if (objectsToUse.length === 0) {
            console.log('[ShowOnlyNetLayers] No objects selected');
            return;
        }
        
        // Get unique layer IDs, excluding vias and PTH pads
        const selectedLayerIds = new Set<string>();
        for (const obj of objectsToUse) {
            // Skip vias (type 2) and PTH pads
            if (obj.obj_type === 2) continue;
            if (obj.layer_id.includes('PTH') || obj.layer_id.includes('Drill')) continue;
            selectedLayerIds.add(obj.layer_id);
        }
        
        if (selectedLayerIds.size === 0) {
            console.log('[ShowOnlyNetLayers] All selected objects are vias/PTH');
            return;
        }
        
        console.log(`[ShowOnlyNetLayers] Showing only layers: ${Array.from(selectedLayerIds).join(', ')}`);
        
        // Update layer visibility
        for (const [layerId] of scene.layerVisible) {
            const shouldBeVisible = selectedLayerIds.has(layerId);
            scene.toggleLayerVisibility(layerId, shouldBeVisible);
        }
        
        ui.updateLayerVisibility(selectedLayerIds);
        
        // Update selection to visible objects only
        const visibleObjects = objectsToUse.filter(obj => selectedLayerIds.has(obj.layer_id));
        if (visibleObjects.length > 0) {
            selectionState.selectedObjects = visibleObjects;
            scene.highlightMultipleObjects(visibleObjects);
            console.log(`[ShowOnlyNetLayers] Updated selection to ${visibleObjects.length} objects`);
        }
    });
    
    // Clear selection handler
    input.setOnClearSelection(() => {
        if (selectionState.selectedObjects.length > 0) {
            console.log('[Input] Escape pressed - clearing selection');
            selectionState.selectedObjects = [];
            scene.clearHighlightObject();
            ui.clearHighlight();
            input.setHasSelection(false);
            input.setHasComponentSelection(false);
        }
    });
}

/**
 * SelectionHandlers - handles selection-related messages from the backend
 */

import { Scene } from "../Scene";
import { Input } from "../Input";
import { ObjectRange } from "../types";
import { SelectionState, UndoRedoState } from "./CommandHandler";

export interface SelectionHandlerDeps {
    scene: Scene;
    input: Input;
    selectionState: SelectionState;
    undoRedoState: UndoRedoState;
}

/**
 * Handle selection result from backend
 */
export function handleSelectionResult(
    deps: SelectionHandlerDeps,
    data: Record<string, unknown>
): void {
    const ranges = data.ranges as ObjectRange[] | undefined;
    if (!ranges) return;
    
    const { scene, input } = deps;
    const state = deps.selectionState;
    
    // Filter out deleted objects and objects from invisible layers
    const visibleRanges = ranges.filter(range => {
        const isDeleted = state.deletedObjectIds.has(range.id);
        const isLayerVisible = scene.layerVisible.get(range.layer_id) !== false;
        return !isDeleted && isLayerVisible;
    });
    
    if (visibleRanges.length > 0) {
        // Sort by layer order (topmost first)
        visibleRanges.sort((a, b) => {
            const aIndex = scene.layerOrder.indexOf(a.layer_id);
            const bIndex = scene.layerOrder.indexOf(b.layer_id);
            return bIndex - aIndex;
        });
        
        if (state.isBoxSelect) {
            state.selectedObjects = visibleRanges;
            scene.highlightMultipleObjects(visibleRanges);
            input.hideTooltip();
        } else if (state.isCtrlSelect) {
            const newObj = visibleRanges[0];
            const existingIndex = state.selectedObjects.findIndex(obj => obj.id === newObj.id);
            
            if (existingIndex >= 0) {
                state.selectedObjects.splice(existingIndex, 1);
                console.log(`[Select] Ctrl+click: removed object ${newObj.id} from selection`);
            } else {
                state.selectedObjects.push(newObj);
                console.log(`[Select] Ctrl+click: added object ${newObj.id} to selection`);
            }
            
            if (state.selectedObjects.length > 0) {
                scene.highlightMultipleObjects(state.selectedObjects);
            } else {
                scene.clearHighlightObject();
            }
            input.hideTooltip();
        } else {
            const selected = visibleRanges[0];
            state.selectedObjects = [selected];
            scene.highlightObject(selected);
        }
        
        state.lastNetHighlightAllObjects = [];
        
        input.setHasSelection(state.selectedObjects.length > 0);
        const hasComponentRef = state.selectedObjects.some(obj => obj.component_ref);
        input.setHasComponentSelection(hasComponentRef);
        const hasNetName = state.selectedObjects.some(obj => obj.net_name && obj.net_name !== 'No Net');
        input.setHasNetSelection(hasNetName);
    } else if (!state.isCtrlSelect) {
        state.selectedObjects = [];
        state.lastNetHighlightAllObjects = [];
        scene.clearHighlightObject();
        input.setHasSelection(false);
        input.setHasComponentSelection(false);
        input.setHasNetSelection(false);
        input.hideTooltip();
    }
}

/**
 * Handle highlight nets result from backend
 */
export function handleHighlightNetsResult(
    deps: SelectionHandlerDeps,
    data: Record<string, unknown>
): void {
    const objects = data.objects as ObjectRange[] | undefined;
    const netNames = data.netNames as string[] | undefined;
    if (!objects) return;
    
    const { scene, input } = deps;
    const state = deps.selectionState;
    
    console.log(`[HighlightNets] Received ${objects.length} objects with nets: ${netNames?.join(', ')}`);
    
    state.lastNetHighlightAllObjects = objects.filter(obj => !state.deletedObjectIds.has(obj.id));
    
    const visibleObjects = objects.filter(obj => {
        const isDeleted = state.deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
    });
    
    if (visibleObjects.length > 0) {
        state.selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightNets] Highlighted ${visibleObjects.length} objects`);
        input.setHasSelection(true);
        input.setHasComponentSelection(visibleObjects.some(obj => obj.component_ref));
        input.setHasNetSelection(true);
    }
}

/**
 * Handle highlight components result from backend
 */
export function handleHighlightComponentsResult(
    deps: SelectionHandlerDeps,
    data: Record<string, unknown>
): void {
    const objects = data.objects as ObjectRange[] | undefined;
    const componentRefs = data.componentRefs as string[] | undefined;
    if (!objects) return;
    
    const { scene, input } = deps;
    const state = deps.selectionState;
    
    console.log(`[HighlightComponents] Received ${objects.length} objects with components: ${componentRefs?.join(', ')}`);
    
    const visibleObjects = objects.filter(obj => {
        const isDeleted = state.deletedObjectIds.has(obj.id);
        const isLayerVisible = scene.layerVisible.get(obj.layer_id) !== false;
        return !isDeleted && isLayerVisible;
    });
    
    if (visibleObjects.length > 0) {
        state.selectedObjects = visibleObjects;
        scene.highlightMultipleObjects(visibleObjects);
        console.log(`[HighlightComponents] Highlighted ${visibleObjects.length} objects`);
        input.setHasSelection(true);
        input.setHasComponentSelection(visibleObjects.some(obj => obj.component_ref));
        input.setHasNetSelection(visibleObjects.some(obj => obj.net_name && obj.net_name !== 'No Net'));
    }
}

/**
 * Handle net at point result (for tooltip)
 */
export function handleNetAtPointResult(
    deps: SelectionHandlerDeps,
    data: Record<string, unknown>
): void {
    const netName = data.netName as string | null;
    const componentRef = data.componentRef as string | null;
    const pinRef = data.pinRef as string | null;
    const clientX = data.x as number;
    const clientY = data.y as number;
    
    if (netName && netName.trim() !== "") {
        const tooltipInfo: { net?: string; component?: string; pin?: string } = {
            net: netName
        };
        if (componentRef) {
            tooltipInfo.component = componentRef.replace(/^CMP:/, '');
        }
        if (pinRef) {
            tooltipInfo.pin = pinRef.replace(/^PIN:/, '');
        }
        deps.input.showSelectionTooltip(tooltipInfo, clientX, clientY);
    }
}

/**
 * Handle delete related objects (e.g., vias across layers)
 */
export function handleDeleteRelatedObjects(
    deps: SelectionHandlerDeps,
    data: Record<string, unknown>
): void {
    const relatedObjects = data.objects as ObjectRange[] | undefined;
    if (!relatedObjects) return;
    
    const { scene } = deps;
    const state = deps.selectionState;
    const undoState = deps.undoRedoState;
    
    console.log(`[Delete] Hiding ${relatedObjects.length} related objects`);
    
    for (const obj of relatedObjects) {
        scene.hideObject(obj);
        state.deletedObjectIds.add(obj.id);
    }
    
    // Add to last undo batch
    if (undoState.undoStack.length > 0) {
        const lastBatch = undoState.undoStack[undoState.undoStack.length - 1];
        for (const obj of relatedObjects) {
            if (!lastBatch.some(existing => existing.id === obj.id)) {
                lastBatch.push(obj);
            }
        }
        console.log(`[Delete] Updated undo batch to ${lastBatch.length} total objects`);
    }
    
    scene.state.needsDraw = true;
}

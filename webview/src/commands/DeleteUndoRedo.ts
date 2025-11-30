/**
 * DeleteUndoRedo - handles delete, undo, and redo operations
 */

import { Scene } from "../Scene";
import { ObjectRange } from "../types";
import { IApiClient } from "../api/types";
import { SelectionState, UndoRedoState } from "./CommandHandler";

const MAX_UNDO_HISTORY = 100;

export interface DeleteUndoRedoDeps {
    scene: Scene;
    api: IApiClient;
    selectionState: SelectionState;
    undoRedoState: UndoRedoState;
}

/**
 * Perform delete operation on selected objects
 */
export function performDelete(
    deps: DeleteUndoRedoDeps,
    objects: ObjectRange[], 
    source: string
): void {
    if (objects.length === 0) return;
    
    const { scene, api, selectionState, undoRedoState } = deps;
    
    console.log(`[Delete] Deleting ${objects.length} object(s) (${source})`);
    
    scene.clearHighlightObject();
    
    for (const obj of objects) {
        scene.hideObject(obj);
        selectionState.deletedObjectIds.add(obj.id);
        api.send({ command: 'Delete', object: obj });
    }
    
    undoRedoState.undoStack.push([...objects]);
    if (undoRedoState.undoStack.length > MAX_UNDO_HISTORY) {
        undoRedoState.undoStack.shift();
    }
    
    undoRedoState.redoStack.length = 0;
    selectionState.selectedObjects = [];
    console.log(`[Delete] Deleted ${objects.length} object(s)`);
}

/**
 * Perform undo operation
 */
export function performUndo(deps: DeleteUndoRedoDeps): void {
    const { scene, api, selectionState, undoRedoState } = deps;
    
    if (undoRedoState.undoStack.length === 0) {
        console.log('[Undo] Nothing to undo');
        return;
    }
    
    const batch = undoRedoState.undoStack.pop()!;
    console.log(`[Undo] Restoring ${batch.length} object(s)`);
    
    for (const obj of batch) {
        scene.showObject(obj);
        selectionState.deletedObjectIds.delete(obj.id);
        api.send({ command: 'Undo', object: obj });
    }
    
    undoRedoState.redoStack.push(batch);
    if (undoRedoState.redoStack.length > MAX_UNDO_HISTORY) {
        undoRedoState.redoStack.shift();
    }
}

/**
 * Perform redo operation
 */
export function performRedo(deps: DeleteUndoRedoDeps): void {
    const { scene, api, selectionState, undoRedoState } = deps;
    
    if (undoRedoState.redoStack.length === 0) {
        console.log('[Redo] Nothing to redo');
        return;
    }
    
    const batch = undoRedoState.redoStack.pop()!;
    console.log(`[Redo] Re-deleting ${batch.length} object(s)`);
    
    for (const obj of batch) {
        scene.hideObject(obj);
        selectionState.deletedObjectIds.add(obj.id);
        api.send({ command: 'Redo', object: obj });
    }
    
    undoRedoState.undoStack.push(batch);
    if (undoRedoState.undoStack.length > MAX_UNDO_HISTORY) {
        undoRedoState.undoStack.shift();
    }
}

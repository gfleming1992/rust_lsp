/**
 * Commands module - centralized command handling and callbacks
 */

export { 
    CommandHandler, 
    type CommandHandlerDeps,
    type SelectionState,
    type UndoRedoState 
} from './CommandHandler';

export { 
    setupInputCallbacks,
    createOnSelectCallback,
    type InputCallbacksDeps 
} from './InputCallbacks';

export {
    setupDrcCallbacks,
    type DrcCallbacksDeps
} from './DrcCallbacks';

export {
    performDelete,
    performUndo,
    performRedo,
    type DeleteUndoRedoDeps
} from './DeleteUndoRedo';

export {
    handleSelectionResult,
    handleHighlightNetsResult,
    handleHighlightComponentsResult,
    handleNetAtPointResult,
    handleDeleteRelatedObjects,
    type SelectionHandlerDeps
} from './SelectionHandlers';

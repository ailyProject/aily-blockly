import * as Blockly from 'blockly';

class LibraryMutationEvent extends Blockly.Events.Abstract {
  override type = 'aily_library_mutation';
  override isBlank = false;
  constructor(workspace: Blockly.WorkspaceSvg, readonly restore: (forward: boolean) => Promise<void>) {
    super();
    this.workspaceId = workspace.id;
    this.group = `library-${crypto.randomUUID()}`;
    this.recordUndo = true;
  }
  override run(_forward: boolean): void { /* The async boundary runs before Blockly moves this event. */ }
}

const installed = new WeakSet<Blockly.WorkspaceSvg>();

/** Blockly's event.run is synchronous. Keep the event on its original stack
 * until dependency/runtime/source restoration has actually completed. */
export function recordLibraryMutation(workspace: Blockly.WorkspaceSvg,
  restore: (forward: boolean) => Promise<void>, failed: (error: unknown) => void): void {
  if (!installed.has(workspace)) {
    installed.add(workspace);
    const undo = workspace.undo;
    let pending = false;
    workspace.undo = function(redo = false): void {
      if (pending) return;
      const stack = redo ? this.getRedoStack() : this.getUndoStack();
      const event = stack.at(-1);
      if (!(event instanceof LibraryMutationEvent)) { undo.call(this, redo); return; }
      pending = true;
      void event.restore(redo).then(() => {
        if (stack.at(-1) !== event) throw new Error('Blockly undo history changed during library restoration.');
        undo.call(this, redo);
      }).catch(failed).finally(() => { pending = false; });
    };
  }
  workspace.getUndoStack().push(new LibraryMutationEvent(workspace, restore));
  workspace.getRedoStack().length = 0;
}

/** Library realm hydration clears Blockly events. Retain their identity and
 * ordering, including asynchronous library steps and earlier user edits. */
export function retainBlocklyHistory(workspace: Blockly.WorkspaceSvg): () => void {
  const undo = [...workspace.getUndoStack()], redo = [...workspace.getRedoStack()];
  return () => {
    workspace.getUndoStack().splice(0, Infinity, ...undo);
    workspace.getRedoStack().splice(0, Infinity, ...redo);
  };
}

import * as Blockly from 'blockly';

/** Exception-safety adapter for the pinned aily-project-blockly@1.0.5 runtime.
 * Keep the native reentrancy checks and propagate the original exception. Only
 * restore transaction flags on unwind; unlocking inside a callback is unsafe.
 * Remove together with its private-contract tests when upgrading to a core that
 * provides these finally blocks itself.
 */
interface FocusInternals {
  lockFocusStateChanges: boolean;
  isUpdatingFocusedNode: boolean;
  currentlyHoldsEphemeralFocus: boolean;
  activelyFocusNode(...args: unknown[]): void;
  passivelyFocusNode(...args: unknown[]): void;
  focusNode(...args: unknown[]): void;
  takeEphemeralFocus(...args: unknown[]): (restoreFocus?: boolean) => void;
}

interface GestureInternals {
  dragger?: { draggable: Blockly.IDraggable };
}

let installed = false;

export function installBlocklyInteractionRecovery(): void {
  if (installed) return;
  installed = true;
  const focus = Blockly.getFocusManager() as unknown as FocusInternals;
  for (const method of ['activelyFocusNode', 'passivelyFocusNode', 'focusNode'] as const) {
    const flag = method === 'focusNode' ? 'isUpdatingFocusedNode' : 'lockFocusStateChanges';
    const original = focus[method];
    focus[method] = function(...args) {
      const previous = this[flag];
      try {
        return original.apply(this, args);
      } finally {
        this[flag] = previous;
      }
    };
  }

  const takeEphemeralFocus = focus.takeEphemeralFocus;
  focus.takeEphemeralFocus = function(...args) {
    const previous = this.currentlyHoldsEphemeralFocus;
    try {
      return takeEphemeralFocus.apply(this, args);
    } catch (error) {
      // No return-focus callback was delivered to the caller.
      this.currentlyHoldsEphemeralFocus = previous;
      throw error;
    }
  };

  const prototype = Blockly.Gesture.prototype;
  const cancel = prototype.cancel;
  const groups = new WeakMap<Blockly.Gesture, string>();
  const recovering = new WeakSet<Blockly.Gesture>();
  for (const method of ['doStart', 'handleMove', 'handleUp', 'cancel'] as const) {
    const original = prototype[method];
    prototype[method] = function(this: Blockly.Gesture, ...args: [PointerEvent?]) {
      if (method === 'doStart') groups.set(this, Blockly.Events.getGroup());
      try {
        return original.apply(this, args);
      } catch (error) {
        if (!recovering.has(this)) {
          recovering.add(this);
          try {
            // Ending a partial drag restores its layers/resizing. Do not retry
            // cancel itself or an already-ending drop (which may delete blocks).
            if (method !== 'cancel') cancel.call(this);
          } catch (cleanupError) {
            console.error('Blockly gesture cleanup failed', cleanupError);
          } finally {
            // A focus callback in moveOffDragLayer can interrupt endDrag before
            // it clears the block's dragging/resizing state. Finish only that
            // still-active block drag, never replay onDrop or deletion hooks.
            const draggable = (this as unknown as GestureInternals).dragger?.draggable;
            try {
              if (draggable instanceof Blockly.BlockSvg && draggable.isDragging() && !draggable.isDeadOrDying()) {
                draggable.endDrag(undefined, Blockly.DragDisposition.COMMIT);
              }
            } catch (cleanupError) {
              console.error('Blockly block drag cleanup failed', cleanupError);
            } finally {
              try {
                Blockly.Touch.longStop();
                this.dispose();
              } finally {
                Blockly.Events.setGroup(groups.get(this) || false);
                groups.delete(this);
                recovering.delete(this);
              }
            }
          }
        }
        throw error;
      }
    };
  }
}

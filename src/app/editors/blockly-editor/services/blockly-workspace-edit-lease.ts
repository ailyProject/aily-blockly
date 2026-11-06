export class BlocklyEditError extends Error {
  constructor(readonly code: 'BLOCKLY_EDIT_BUSY' | 'BLOCKLY_EDIT_STALE' | 'BLOCKLY_WORKSPACE_TAINTED', message: string) {
    super(message); this.name = 'BlocklyEditError';
  }
}

export interface BlocklyWorkspaceEditLease {
  assertCurrent(): void;
  release(): void;
  quarantine(reason: string): BlocklyWorkspaceRecoveryGrant | void;
}

declare const recoveryGrant: unique symbol;
/** Host-private object identity, never serialized to an Agent capability. */
export interface BlocklyWorkspaceRecoveryGrant { readonly [recoveryGrant]: true; }
export interface BlocklyWorkspaceRecoveryLease extends BlocklyWorkspaceEditLease { completeRecovery(): void; }

/** Explicit ownership. Only the owner of this exact quarantine may restore it. */
export class BlocklyWorkspaceEditGate {
  private active: BlocklyWorkspaceEditLease | undefined;
  private tainted: string | undefined;
  private epoch = 0;
  private grant?: BlocklyWorkspaceRecoveryGrant;
  private recovering?: BlocklyWorkspaceEditLease;
  constructor(private readonly recoveryChanged: (required: boolean) => void = () => {}) {}
  get blocked(): boolean { return !!this.active || !!this.tainted; }
  get busy(): boolean { return !!this.active; }
  get recoveryRequired(): boolean { return !!this.tainted; }

  assertAvailable(owner?: BlocklyWorkspaceEditLease): void {
    if (this.tainted && (!owner || owner !== this.recovering || owner !== this.active)) {
      throw new BlocklyEditError('BLOCKLY_WORKSPACE_TAINTED', this.tainted);
    }
    if (owner) {
      if (owner !== this.active) throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'Workspace edit lease is no longer active.');
    } else if (this.active) throw new BlocklyEditError('BLOCKLY_EDIT_BUSY', 'Blockly 工作区正在应用更改，请稍后重试。');
  }

  acquire(): BlocklyWorkspaceEditLease {
    this.assertAvailable();
    return this.createLease();
  }

  acquireRecovery(grant: BlocklyWorkspaceRecoveryGrant): BlocklyWorkspaceRecoveryLease {
    if (!this.tainted || grant !== this.grant || this.active) {
      throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'This recovery no longer owns the quarantined workspace.');
    }
    const lease = this.createLease() as BlocklyWorkspaceRecoveryLease;
    this.recovering = lease;
    lease.completeRecovery = () => {
      lease.assertCurrent();
      if (this.grant !== grant || this.recovering !== lease) {
        throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'Recovery ownership changed.');
      }
      this.tainted = undefined; this.grant = undefined; this.recovering = undefined;
      this.recoveryChanged(false);
    };
    return lease;
  }

  private createLease(): BlocklyWorkspaceEditLease {
    const epoch = this.epoch;
    const lease: BlocklyWorkspaceEditLease = {
      assertCurrent: () => {
        if (epoch !== this.epoch) throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'Workspace activation changed.');
        this.assertAvailable(lease);
      },
      release: () => { if (this.active === lease) this.active = undefined; if (this.recovering === lease) this.recovering = undefined; },
      quarantine: reason => {
        if (epoch !== this.epoch || this.active !== lease) return;
        const wasTainted = this.recoveryRequired;
        this.tainted = reason || '工作区恢复未完成；请查询宿主提供的受保护恢复动作。';
        if (!wasTainted) this.recoveryChanged(true);
        return this.grant ??= Object.freeze({}) as BlocklyWorkspaceRecoveryGrant;
      },
    };
    this.active = lease;
    return lease;
  }

  reset(): void {
    const wasTainted = this.recoveryRequired;
    this.epoch++; this.active = undefined; this.tainted = undefined; this.grant = undefined; this.recovering = undefined;
    if (wasTainted) this.recoveryChanged(false);
  }
}

/** Input fence only: never changes block flags or workspace.readOnly, which affect serialization. */
export function fenceBlocklyWorkspaceInput(root: Element | undefined, options: { allowNavigation?: boolean } = {}): () => void {
  if (!root) return () => undefined;
  const document = root.ownerDocument;
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const pointer = (event: Event) => {
    const target = event.target as Element | null;
    // npm/history I/O does not replace the canvas. Keep its background pan,
    // scrollbars and zoom usable while editing its soon-to-change definitions
    // is fenced. Save/ABS/runtime replacement retain the default strict fence.
    if (options.allowNavigation && target?.closest && ['pointerdown', 'mousedown', 'touchstart', 'click', 'wheel'].includes(event.type)
      && target.closest('.blocklyMainBackground, .blocklyScrollbarHandle, .blocklyScrollbarBackground, .blocklyZoom')) return;
    block(event);
  };
  const keys = (event: Event) => {
    const key = event as KeyboardEvent;
    // Saving is admitted by the project coordinator, not Blockly editing.
    // Keep Ctrl/Cmd+S reachable so a quarantined canvas can offer its complete
    // recovery of the current view; do not pass delete, undo, paste or other editing shortcuts.
    if ((key.ctrlKey || key.metaKey) && !key.altKey && !key.shiftKey && key.key?.toLowerCase() === 's') return;
    const target = event.target as Node | null;
    if (target === document || target === document.body || (target && root.contains(target))) block(event);
  };
  const events = ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click', 'dblclick', 'contextmenu', 'drop', 'paste', 'cut'];
  events.forEach(name => root.addEventListener(name, pointer, { capture: true, passive: false }));
  // Fence before document-level shortcut dispatch. Use an explicitly
  // non-passive capture listener so keyboard defaults are cancelled as well
  // as propagation, including in the Electron/Zone event bridge.
  const keyboardTarget = document.defaultView ?? document;
  keyboardTarget.addEventListener('keydown', keys, { capture: true, passive: false });
  return () => {
    events.forEach(name => root.removeEventListener(name, pointer, true));
    keyboardTarget.removeEventListener('keydown', keys, true);
  };
}

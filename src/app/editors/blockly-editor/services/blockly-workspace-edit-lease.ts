export class BlocklyEditError extends Error {
  constructor(readonly code: 'BLOCKLY_EDIT_BUSY' | 'BLOCKLY_EDIT_STALE' | 'BLOCKLY_WORKSPACE_TAINTED', message: string) {
    super(message); this.name = 'BlocklyEditError';
  }
}

export interface BlocklyWorkspaceEditLease {
  assertCurrent(): void;
  release(): void;
  quarantine(reason: string): void;
}

/** Explicit ownership, not a boolean bypass. Recovery requires a new workspace activation. */
export class BlocklyWorkspaceEditGate {
  private active: BlocklyWorkspaceEditLease | undefined;
  private tainted: string | undefined;
  private epoch = 0;
  get blocked(): boolean { return !!this.active || !!this.tainted; }
  get busy(): boolean { return !!this.active; }

  assertAvailable(owner?: BlocklyWorkspaceEditLease): void {
    if (this.tainted) throw new BlocklyEditError('BLOCKLY_WORKSPACE_TAINTED', this.tainted);
    if (owner) {
      if (owner !== this.active) throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'Workspace edit lease is no longer active.');
    } else if (this.active) throw new BlocklyEditError('BLOCKLY_EDIT_BUSY', 'Blockly 工作区正在应用更改，请稍后重试。');
  }

  acquire(): BlocklyWorkspaceEditLease {
    this.assertAvailable();
    const epoch = this.epoch;
    const lease: BlocklyWorkspaceEditLease = {
      assertCurrent: () => {
        if (epoch !== this.epoch) throw new BlocklyEditError('BLOCKLY_EDIT_STALE', 'Workspace activation changed.');
        this.assertAvailable(lease);
      },
      release: () => { if (this.active === lease) this.active = undefined; },
      quarantine: reason => {
        if (epoch === this.epoch && this.active === lease) this.tainted = reason || '工作区恢复失败，请关闭并重新打开工程。';
      },
    };
    this.active = lease;
    return lease;
  }

  reset(): void { this.epoch++; this.active = undefined; this.tainted = undefined; }
}

/** Input fence only: never changes block flags or workspace.readOnly, which affect serialization. */
export function fenceBlocklyWorkspaceInput(root: Element | undefined): () => void {
  if (!root) return () => undefined;
  const document = root.ownerDocument;
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const keys = (event: Event) => {
    const target = event.target as Node | null;
    if (target === document || target === document.body || (target && root.contains(target))) block(event);
  };
  const events = ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click', 'dblclick', 'contextmenu', 'drop', 'paste', 'cut'];
  events.forEach(name => root.addEventListener(name, block, { capture: true, passive: false }));
  document.addEventListener('keydown', keys, true);
  return () => {
    events.forEach(name => root.removeEventListener(name, block, true));
    document.removeEventListener('keydown', keys, true);
  };
}

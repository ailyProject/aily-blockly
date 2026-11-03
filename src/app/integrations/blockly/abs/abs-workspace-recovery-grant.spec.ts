import { BlocklyWorkspaceEditGate, fenceBlocklyWorkspaceInput, type BlocklyWorkspaceRecoveryGrant } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';

describe('private workspace quarantine recovery ownership', () => {
  function failed() {
    const gate = new BlocklyWorkspaceEditGate(), original = gate.acquire();
    const grant = original.quarantine('native reconstruction failed') as BlocklyWorkspaceRecoveryGrant;
    original.release(); return { gate, original, grant };
  }
  it('does not expose ordinary editing while a private recovery is active', () => {
    const f = failed(), recovery = f.gate.acquireRecovery(f.grant);
    recovery.assertCurrent(); expect(() => f.gate.acquire()).toThrow();
    expect(() => f.gate.assertAvailable()).toThrow(); expect(() => f.original.assertCurrent()).toThrow();
    recovery.completeRecovery(); expect(() => f.gate.acquire()).toThrow(); recovery.release();
    const edit = f.gate.acquire(); edit.assertCurrent(); edit.release(); expect(f.gate.blocked).toBeFalse();
  });
  it('failure or release without verified completion cannot clear quarantine', () => {
    const f = failed(), recovery = f.gate.acquireRecovery(f.grant);
    expect(recovery.quarantine('still failed')).toBe(f.grant); recovery.release();
    expect(f.gate.blocked).toBeTrue(); expect(() => f.gate.acquire()).toThrow();
    const next = f.gate.acquireRecovery(f.grant); next.assertCurrent(); next.release(); expect(f.gate.blocked).toBeTrue();
  });
  it('rejects a serialized or invented grant', () => {
    const f = failed();
    expect(() => f.gate.acquireRecovery({} as BlocklyWorkspaceRecoveryGrant)).toThrow();
    expect(() => f.gate.acquireRecovery(JSON.parse(JSON.stringify(f.grant)))).toThrow(); expect(f.gate.blocked).toBeTrue();
  });
  it('an old recovery cannot lift a new activation or quarantine', () => {
    const f = failed(), recovery = f.gate.acquireRecovery(f.grant);
    f.gate.reset(); const next = f.gate.acquire(); const grant = next.quarantine('new failure'); next.release();
    expect(grant).not.toBe(f.grant); expect(() => recovery.completeRecovery()).toThrow();
    expect(() => f.gate.acquireRecovery(f.grant)).toThrow(); expect(f.gate.blocked).toBeTrue();
  });
  it('keeps host save reachable while destructive workspace shortcuts stay fenced', () => {
    const root = document.createElement('div'); document.body.append(root);
    const release = fenceBlocklyWorkspaceInput(root);
    try {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const save = new KeyboardEvent('keydown', { key: 's', [modifier]: true, bubbles: true, cancelable: true });
        expect(root.dispatchEvent(save)).toBeTrue(); expect(save.defaultPrevented).toBeFalse();
      }
      for (const key of ['Delete', 'z', 'v']) expect(root.dispatchEvent(new KeyboardEvent('keydown', {
        key, ctrlKey: key !== 'Delete', bubbles: true, cancelable: true }))).toBeFalse();
    } finally { release(); root.remove(); }
  });
});

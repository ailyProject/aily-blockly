import { BlocklyWorkspaceEditGate, fenceBlocklyWorkspaceInput } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';

describe('workspace edit lease', () => {
  it('requires the exact active owner and rejects nested acquisition', () => {
    const gate = new BlocklyWorkspaceEditGate();
    const owner = gate.acquire();
    expect(() => gate.acquire()).toThrow();
    expect(() => gate.assertAvailable()).toThrow();
    expect(() => gate.assertAvailable({ ...owner })).toThrow();
    expect(() => gate.assertAvailable(owner)).not.toThrow();
    owner.release(); owner.release();
    expect(() => owner.assertCurrent()).toThrow();
    expect(() => gate.assertAvailable()).not.toThrow();
  });
  it('quarantines a failed workspace after releasing the writer until activation resets', () => {
    const gate = new BlocklyWorkspaceEditGate();
    const owner = gate.acquire(); owner.quarantine('rollback failed'); owner.release();
    expect(gate.blocked).toBeTrue();
    expect(() => gate.acquire()).toThrowMatching(error => error.code === 'BLOCKLY_WORKSPACE_TAINTED');
    gate.reset(); expect(() => gate.assertAvailable()).not.toThrow();
  });
  it('does not let an old lease release or quarantine a newly activated workspace', () => {
    const gate = new BlocklyWorkspaceEditGate(); const old = gate.acquire();
    gate.reset(); const next = gate.acquire();
    old.release(); old.quarantine('old failure');
    expect(() => old.assertCurrent()).toThrow();
    expect(() => next.assertCurrent()).not.toThrow();
    expect(() => gate.assertAvailable()).toThrow();
    next.release(); expect(() => gate.assertAvailable()).not.toThrow();
  });
  it('fences native input and global workspace shortcuts without blocking another text editor', () => {
    const root = document.createElement('div'); const child = document.createElement('button'); root.appendChild(child);
    const chat = document.createElement('input'); document.body.append(root, chat);
    const release = fenceBlocklyWorkspaceInput(root);
    const event = (type: string) => new Event(type, { bubbles: true, cancelable: true });
    try {
      expect(child.dispatchEvent(event('pointerdown'))).toBeFalse();
      expect(child.dispatchEvent(event('paste'))).toBeFalse();
      expect(child.dispatchEvent(event('keydown'))).toBeFalse();
      expect(document.body.dispatchEvent(event('keydown'))).toBeFalse();
      expect(chat.dispatchEvent(event('keydown'))).toBeTrue();
      release(); release();
      expect(child.dispatchEvent(event('pointerdown'))).toBeTrue();
      expect(document.body.dispatchEvent(event('keydown'))).toBeTrue();
    } finally { release(); root.remove(); chat.remove(); }
  });
});

describe('persisted project revision', () => {
  it('tracks layout, protection, view, other-page and custom serializer changes without code events', () => {
    const tracker = new BlocklyProjectRevision();
    const document: any = { blocks: [{ id: 'b', x: 10, deletable: false }], pages: [{ title: 'One' }], custom: { hidden: 1 }, view: { scale: 1 } };
    let revision = tracker.observe(document);
    for (const edit of [
      () => document.blocks[0].x++, () => document.blocks[0].deletable = true,
      () => document.pages[0].title = 'Renamed', () => document.custom.hidden++, () => document.view.scale++,
    ]) {
      edit(); expect(tracker.observe(document)).toBeGreaterThan(revision); revision = tracker.current;
    }
  });
  it('is stable for equivalent JSON key order and invalidates on activation', () => {
    const tracker = new BlocklyProjectRevision(); const first = tracker.observe({ a: 1, b: 2 });
    expect(tracker.observe({ b: 2, a: 1 })).toBe(first);
    tracker.invalidate(); expect(tracker.observe({ a: 1, b: 2 })).toBeGreaterThan(first);
  });
  it('detects a changed state that returns to its earlier content after it has been observed', () => {
    const tracker = new BlocklyProjectRevision(); const first = tracker.observe({ value: 1 });
    tracker.observe({ value: 2 }); expect(tracker.observe({ value: 1 })).toBeGreaterThan(first);
  });
});

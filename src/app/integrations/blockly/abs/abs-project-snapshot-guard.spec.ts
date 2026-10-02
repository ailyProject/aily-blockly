import { createAbsProjectSnapshotGuard } from './abs-project-snapshot-guard';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { normalizeBlocklyOwnership, normalizeBlocklyWorkspace } from '../../../editors/blockly-editor/services/blockly-project-model';

describe('ABS phase-local snapshot guard', () => {
  const document = (): any => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'Main', viewState: { scale: 1, scrollX: 0, scrollY: 0 },
      content: { blocks: { blocks: [{ id: 'root', type: 'root', x: 30, y: 60, deletable: false,
        fields: { TEXT: 'before' }, extraState: { x: 2 } }] } } },
      { id: 'other', title: 'Other', content: { blocks: { blocks: [] } } }],
    sharedModel: { variables: [{ id: 'v', name: 'counter', type: 'int' }], procedureBlocks: [] }, metadata: 'retained' });

  it('observes full content every time but compares a settled layout revision only once', () => {
    const revisions = new BlocklyProjectRevision();
    let current = document(), reads = 0;
    const watch = () => Object.defineProperty(current, 'metadata', { enumerable: true, configurable: true,
      get: () => { reads++; return 'retained'; } });
    watch();
    const capture = jasmine.createSpy('capture').and.callFake(() => ({ document: current, revision: revisions.observe(current) }));
    const initial = capture(); reads = 0;
    const guard = createAbsProjectSnapshotGuard(initial, capture, () => undefined);
    expect(reads).toBe(1); // Immutable baseline program bytes, once per phase.
    current = document(); current.pages[0].viewState.scrollY = 20; watch();
    reads = 0; capture.calls.reset();
    let sameDocument = true;
    for (let i = 0; i < 32; i++) sameDocument = (guard().document === current) && sameDocument;
    const observedReads = reads; // Jasmine's object formatting may itself read getters.
    expect(sameDocument).toBeTrue();
    expect(capture.calls.count()).toBe(32);
    expect(observedReads).toBe(33); // 32 complete observations + one program comparison.
    current.pages[0].viewState.scrollY = 40;
    const next = guard(), nextReads = reads;
    expect(next.document === current).toBeTrue();
    expect(nextReads).toBe(35); // Another actual revision is compared, not assumed safe.
  });

  for (const [kind, change] of Object.entries({
    field: (d: any) => d.pages[0].content.blocks.blocks[0].fields.TEXT = 'changed',
    protection: (d: any) => d.pages[0].content.blocks.blocks[0].deletable = true,
    extension: (d: any) => d.pages[0].content.blocks.blocks[0].extraState.x++,
    otherPage: (d: any) => d.pages[1].title = 'Changed',
    sharedModel: (d: any) => d.sharedModel.variables[0].name = 'renamed',
    viewportExtension: (d: any) => d.pages[0].viewState.extension = true,
  })) it('rejects direct ' + kind + ' changes after layout acceptance without requiring Blockly events', () => {
    const revisions = new BlocklyProjectRevision(); let current = document();
    const capture = () => ({ document: current, revision: revisions.observe(current) });
    const initial = capture(), guard = createAbsProjectSnapshotGuard(initial, capture, () => undefined);
    current = document(); current.pages[0].viewState.scrollX = 100; guard(); guard();
    change(current);
    for (let i = 0; i < 2; i++) expect(guard).toThrow(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
    current = document(); expect(() => guard()).not.toThrow();
  });

  it('does not let a mutated retained snapshot redefine the original program', () => {
    const revisions = new BlocklyProjectRevision(), current = document();
    const capture = () => ({ document: current, revision: revisions.observe(current) });
    const initial = capture(), guard = createAbsProjectSnapshotGuard(initial, capture, () => undefined);
    initial.document.pages[0].title = 'silently changed';
    expect(guard).toThrow(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
  });

  it('checks context both before and after a serializer callback', () => {
    const initial = { document: document(), revision: 1 }; let current = true;
    const context = jasmine.createSpy('context').and.callFake(() => { if (!current) throw new Error('stale context'); });
    const capture = jasmine.createSpy('capture').and.callFake(() => { current = false; return initial; });
    const guard = createAbsProjectSnapshotGuard(initial, capture, context);
    expect(guard).toThrowError('stale context'); expect(context.calls.count()).toBe(2);
    expect(capture.calls.count()).toBe(1);
    expect(guard).toThrowError('stale context'); expect(capture.calls.count()).toBe(1);
  });

  it('owns separate baselines across phases', () => {
    const revisions = new BlocklyProjectRevision(); let current = document();
    const capture = () => ({ document: current, revision: revisions.observe(current) });
    const first = createAbsProjectSnapshotGuard(capture(), capture, () => undefined);
    current = document(); current.pages[0].title = 'New baseline';
    const second = createAbsProjectSnapshotGuard(capture(), capture, () => undefined);
    expect(() => second()).not.toThrow();
    expect(first).toThrow(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
  });

  it('normalizes ownership with one deep copy and keeps both public boundaries detached', () => {
    const source = document(), before = JSON.stringify(source);
    const copies = spyOn(JSON, 'stringify').and.callThrough();
    const normalized = normalizeBlocklyOwnership(source);
    const count = copies.calls.count(); expect(count).toBe(1);
    expect(JSON.stringify(source)).toBe(before);
    normalized.pages[0].content.blocks.blocks[0].fields.TEXT = 'modified';
    normalized.sharedModel.variables![0].name = 'modified';
    expect(JSON.stringify(source)).toBe(before);
    const workspace = normalizeBlocklyWorkspace(source.pages[0].content);
    workspace.blocks.blocks[0].fields.TEXT = 'another modification';
    expect(JSON.stringify(source)).toBe(before);
  });
});

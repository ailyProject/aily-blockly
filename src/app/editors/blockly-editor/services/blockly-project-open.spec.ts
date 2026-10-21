import * as Blockly from 'blockly';
import { BlocklyService } from './blockly.service';
import { BlocklyDeclarativeBlockCatalog } from './blockly-declarative-block-catalog';
import { BlocklyWorkspaceEditGate } from './blockly-workspace-edit-lease';
import { BlocklyProjectDocument } from './blockly-project-model';

describe('cooperative project opening', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg, service: BlocklyService;
  let gate: BlocklyWorkspaceEditGate, published: jasmine.Spy;
  const type = 'project_open_step';
  const documentWith = (count: number): BlocklyProjectDocument => {
    let block: any;
    for (let n = count - 1; n >= 0; n--) block = {
      type, id: `step${n}`, fields: { TEXT: `value${n}` }, ...(block ? { next: { block } } : {}),
    };
    return { schemaVersion: 3, activePageId: 'one', openedPageIds: ['one'], sharedModel: { procedureBlocks: [] },
      pages: [{ id: 'one', title: 'One', content: { blocks: { blocks: [block] } } }] };
  };
  beforeEach(() => {
    Blockly.Blocks[type] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput(''), 'TEXT');
      this.setPreviousStatement(true); this.setNextStatement(true);
    } };
    host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    workspace = Blockly.inject(host, { sounds: false });
    gate = new BlocklyWorkspaceEditGate(); published = jasmine.createSpy('published');
    let stored: BlocklyProjectDocument;
    service = Object.create(BlocklyService.prototype);
    // Keep native loading, ownership checks and cancellation real; isolate only
    // publication/UI services that are covered by the Electron open test.
    Object.assign(service, { _workspace: workspace, workspaceEditGate: gate, iconsMap: new Map(),
      declarativeBlocks: new BlocklyDeclarativeBlockCatalog(),
      applyProjectDocument: value => { stored = value; }, getStoredProjectDocument: () => stored,
      getActivePage: () => stored.pages[0], finishActivePageLoad: published });
  });
  afterEach(() => { workspace.dispose(); host.remove(); delete Blockly.Blocks[type]; });

  for (const size of [2, 1100]) it(`keeps fields/connections complete and events balanced before publishing ${size} blocks`, async () => {
    const lease = gate.acquire(); const events = Blockly.Events.isEnabled();
    try {
      await service.loadProjectDocumentForOpen(documentWith(size), lease, () => {});
      expect(workspace.getAllBlocks(false).length).toBe(size);
      expect(workspace.getTopBlocks(false).map(block => block.id)).toEqual(['step0']);
      for (let n = 0; n < size; n++) {
        const block = workspace.getBlockById(`step${n}`)!;
        expect(block.getFieldValue('TEXT')).toBe(`value${n}`);
        expect(block.getNextBlock()?.id ?? null).toBe(n + 1 === size ? null : `step${n + 1}`);
      }
      expect(workspace.getCanvas().style.display).toBe('');
      expect(Blockly.Events.isEnabled()).toBe(events);
      expect(published).toHaveBeenCalledTimes(1);
      expect(() => service.assertWorkspaceEditAvailable()).toThrow();
    } finally { lease.release(); }
    expect(() => service.assertWorkspaceEditAvailable()).not.toThrow();
  });

  it('lets navigation cancel between fragments without publishing partial state and permits a later open', async () => {
    let current = true;
    const lease = gate.acquire(), events = Blockly.Events.isEnabled();
    const timer = setTimeout(() => { current = false; }, 0);
    try {
      await expectAsync(service.loadProjectDocumentForOpen(documentWith(1100), lease,
        () => { if (!current) throw new Error('stale project'); })).toBeRejectedWithError('stale project');
      expect(published).not.toHaveBeenCalled();
      expect(workspace.getCanvas().style.display).toBe('');
      expect(Blockly.Events.isEnabled()).toBe(events);
      expect(workspace.getAllBlocks(false).length).toBeLessThan(1100);
      current = true;
      await service.loadProjectDocumentForOpen(documentWith(2), lease, () => {});
      expect(workspace.getAllBlocks(false).length).toBe(2);
      expect(published).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); lease.release(); }
  });

  it('restores saved zoom and pan before the loaded canvas can paint', async () => {
    const project = documentWith(1100);
    project.pages[0].viewState = { scale: 0.6, scrollX: -40, scrollY: -250 };
    const frames: string[] = [];
    let frame: number;
    const sample = () => {
      const canvas = workspace.getCanvas();
      if (canvas.isConnected && canvas.querySelector('.blocklyPath')) frames.push(canvas.getAttribute('transform')!);
      frame = requestAnimationFrame(sample);
    };
    // Match publication's existing restoration too: the regression is the
    // earlier visible frame, not the final saved view after opening finishes.
    published.and.callFake(() => (service as any).restoreWorkspaceViewState(project.pages[0].viewState));
    const lease = gate.acquire();
    frame = requestAnimationFrame(sample);
    try {
      await service.loadProjectDocumentForOpen(project, lease, () => {});
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(workspace.scale).toBe(0.6);
      expect(frames.length).toBeGreaterThan(0);
      expect([...new Set(frames)]).toEqual([workspace.getCanvas().getAttribute('transform')!]);
    } finally { cancelAnimationFrame(frame!); lease.release(); }
  });

  it('rejects a stale lease before changing the current project', async () => {
    const lease = gate.acquire(); gate.reset();
    await expectAsync(service.loadProjectDocumentForOpen(documentWith(1100), lease, () => {})).toBeRejected();
    expect(workspace.getAllBlocks(false)).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  it('restores undo settings and the canvas after native block construction fails', async () => {
    const document = documentWith(1100);
    let tail = document.pages[0].content.blocks.blocks[0];
    while (tail.next?.block) tail = tail.next.block;
    tail.type = 'missing_project_open_type';
    const lease = gate.acquire(), group = Blockly.Events.getGroup(), recordUndo = Blockly.Events.getRecordUndo();
    try {
      Blockly.Events.setGroup('existing-edit'); Blockly.Events.setRecordUndo(true);
      await expectAsync(service.loadProjectDocumentForOpen(document, lease, () => {})).toBeRejected();
      expect(Blockly.Events.getGroup()).toBe('existing-edit');
      expect(Blockly.Events.getRecordUndo()).toBeTrue();
      expect(workspace.getCanvas().isConnected).toBeTrue();
      expect(published).not.toHaveBeenCalled();
    } finally { lease.release(); Blockly.Events.setGroup(group); Blockly.Events.setRecordUndo(recordUndo); }
  });
});

import { Subject } from 'rxjs';
import { assertProjectLoadPreserved, BlocklyProjectCleanState } from '../../../editors/blockly-editor/services/blockly-project-clean-state';
import { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { createAilyProjectDataValue, projectDataRuntime } from '@domain/project/public-api';
import { ProjectApplicationAdapter } from '../../project/project-application.adapter';
import { HeaderComponent } from '../../../main-window/components/header/header.component';
import { ProjectNewComponent } from '../../../pages/project-new/project-new.component';

const source = (): BlocklyProjectDocument => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
  $ailyProjectData: { schemaVersion: 1, mode: 'external-only' },
  pages: [{ id: 'main', title: 'Main', content: { blocks: { languageVersion: 0, blocks: [
    { type: 'controls_ifelse', id: 'if', deletable: false, fields: { TEST: 'kept' } },
  ] } } }, { id: 'other', title: 'Other', content: { blocks: { languageVersion: 0, blocks: [] } } }],
  sharedModel: { procedureBlocks: [] } });

describe('project loaded-state admission and comparison', () => {
  let state: BlocklyProjectCleanState;
  let before: BlocklyProjectDocument;
  let after: BlocklyProjectDocument;
  beforeEach(() => {
    state = new BlocklyProjectCleanState(); before = source(); after = structuredClone(before);
    after.pages[0].content.blocks.blocks[0].extraState = { hasElse: true };
  });
  it('accepts native omitted defaults but still detects later edits and undo', () => {
    assertProjectLoadPreserved(before, after); state.remember(['project', 1], 'disk', after);
    expect(state.compare(['project', 1], 'disk', after)).toBeFalse();
    const edited = structuredClone(after); edited.pages[0].content.blocks.blocks[0].extraState.hasElse = false;
    expect(state.compare(['project', 1], 'disk', edited)).toBeTrue();
    expect(state.compare(['project', 1], 'disk', after)).toBeFalse();
  });
  for (const [name, change] of [
    ['deleted block', (d: any) => d.pages[0].content.blocks.blocks.pop()],
    ['added block', (d: any) => d.pages[0].content.blocks.blocks.push({ id: 'unexpected', type: 'text' })],
    ['changed field', (d: any) => d.pages[0].content.blocks.blocks[0].fields.TEST = 'lost'],
    ['changed protection', (d: any) => d.pages[0].content.blocks.blocks[0].deletable = true],
    ['changed title', (d: any) => d.pages[1].title = 'lost'],
    ['added variable', (d: any) => d.sharedModel.variables = [{ id: 'v', name: 'unexpected' }]],
  ] as const) it(`does not acknowledge ${name} as native defaults`, () => {
    change(after); expect(() => assertProjectLoadPreserved(before, after)).toThrow();
  });
  it('keeps specified extraState and extension payloads strict', () => {
    before.pages[0].content.blocks.blocks[0].extraState = { hasElse: false };
    expect(() => assertProjectLoadPreserved(before, after)).toThrow();
    before = source(); before.pages[0].content.opaque = { keep: true };
    expect(() => assertProjectLoadPreserved(before, after)).toThrow();
  });
  it('does not impose ABS syntax depth on ordinary loaded project chains', () => {
    let block = before.pages[0].content.blocks.blocks[0];
    for (let n = 0; n < 200; n++) {
      block.next = { block: { id: `chain-${n}`, type: 'text_print' } }; block = block.next.block;
    }
    expect(() => assertProjectLoadPreserved(before, structuredClone(before))).not.toThrow();
  });
  it('never reuses a record for an external file write or another runtime', () => {
    state.remember(['project', 1], 'disk', after);
    expect(() => state.compare(['project', 1], 'external', after)).toThrowError(/outside/);
    expect(() => state.compare(['project', 2], 'disk', after)).toThrowError(/runtime changed/);
    state.clear(); expect(state.compare(['project', 2], 'disk', after)).toBeUndefined();
  });
  it('remembers a detached copy, and a failed load is not clean', () => {
    state.remember(['p'], 'disk', after); after.pages[0].title = 'edit';
    expect(state.compare(['p'], 'disk', after)).toBeTrue();
    state.reject(new Error('load failed')); expect(() => state.compare(['p'], 'disk', before)).toThrowError('load failed');
  });
  it('adopts hydration only for untouched content, preserving edits to other pages', () => {
    state.remember(['p'], 'disk', before);
    state.acceptHydration(['p'], before, after);
    expect(state.compare(['p'], 'disk', after)).toBeFalse();
    const edited = structuredClone(after); edited.pages[1].title = 'user title';
    state.acceptHydration(['p'], edited, edited);
    expect(state.compare(['p'], 'disk', edited)).toBeTrue();
    const blockEdit = structuredClone(after); blockEdit.pages[0].content.blocks.blocks[0].fields.TEST = 'user';
    state.acceptHydration(['p'], blockEdit, blockEdit);
    expect(state.compare(['p'], 'disk', blockEdit)).toBeTrue();
  });

  it('accepts first-visit viewport initialization but never acknowledges an existing layout edit', () => {
    state.remember(['p'], 'disk', before);
    after.pages[0].viewState = { scale: 1, scrollX: 0, scrollY: 0 };
    state.acceptHydration(['p'], before, after);
    expect(state.compare(['p'], 'disk', after)).toBeFalse();
    const edited = structuredClone(after); edited.pages[0].viewState!.scrollX = 200;
    state.acceptHydration(['p'], edited, edited);
    expect(state.compare(['p'], 'disk', edited)).toBeTrue();
    expect(state.compare(['p'], 'disk', after)).toBeFalse();
  });

  for (const [name, change] of [
    ['numeric input', d => d.pages[0].content.blocks.blocks[0].inputs = { VALUE: { block: { type: 'math_number', id: 'n', fields: { NUM: 8 } } } }],
    ['block deletion', d => d.pages[0].content.blocks.blocks = []],
    ['block addition', d => d.pages[1].content.blocks.blocks.push({ type: 'text', id: 'new' })],
    ['comment', d => d.pages[0].content.blocks.blocks[0].icons = { comment: { text: 'user note' } }],
    ['protection', d => d.pages[0].content.blocks.blocks[0].deletable = true],
    ['variable', d => d.sharedModel.variables = [{ id: 'v', name: 'value' }]],
    ['procedure', d => d.sharedModel.procedureBlocks.push({ type: 'procedures_defnoreturn', id: 'f', fields: { NAME: 'task' } })],
    ['serializer', d => d.pages[1].content.extension = { configuration: 'user' }],
    ['page order', d => d.pages.reverse()],
    ['page name', d => d.pages[1].title = 'renamed'],
    ['shared extension', d => d.sharedModel.extension = { x: 1 }],
  ] as Array<[string, (document: any) => void]>) it(`keeps ${name} dirty across hydration, undo and redo`, () => {
    state.remember(['p'], 'disk', after);
    const edited = structuredClone(after); change(edited);
    expect(state.compare(['p'], 'disk', edited)).toBeTrue();
    state.acceptHydration(['p'], edited, edited);
    expect(state.compare(['p'], 'disk', edited)).toBeTrue();
    expect(state.compare(['p'], 'disk', after)).toBeFalse();
    expect(state.compare(['p'], 'disk', edited)).toBeTrue();
  });
});

describe('editor unsaved-state resource and lifecycle boundary', () => {
  let fs: unknown; let disk: string; let document: any; let revision: number;
  let service: _ProjectService; let editor: any;
  beforeEach(() => {
    fs = window['fs']; document = source(); disk = JSON.stringify(document); revision = 1;
    window['fs'] = { readFileSync: () => disk };
    editor = { workspace: {}, getActivePageId: () => document.activePageId,
      projectPageHydrated: new Subject(), captureProjectSnapshot: () => ({ document, revision }),
      getWorkspaceLoadReadbackView: value => value,
      normalizeProjectAbi: value => value, getProjectAbiForSave: (value = document) => value };
    service = new _ProjectService(editor, { listen() {}, unlisten() {} } as any, {} as any);
    service.currentProjectPath = 'D:/project';
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'getPrepared').and.throwError('cold cache');
  });
  afterEach(() => { service.destroy(); window['fs'] = fs; });
  it('retains the authoritative open snapshot across repeated checks and detects edits', async () => {
    const original = structuredClone(document);
    document.pages[0].content.blocks.blocks[0].extraState = { hasElse: true };
    service.rememberLoadedProject('D:/project', disk, original);
    for (let n = 0; n < 3; n++) expect(await service.hasUnsavedChanges()).toBeFalse();
    document.pages[1].title = 'user edit'; expect(await service.hasUnsavedChanges()).toBeTrue();
    expect(projectDataRuntime.getPrepared).not.toHaveBeenCalled();
  });
  it('accepts only the explicit board-template load, not global empty equivalence', async () => {
    disk = JSON.stringify({ blocks: { blocks: [] } });
    service.rememberLoadedProject('D:/project', disk, structuredClone(document));
    expect(await service.hasUnsavedChanges()).toBeFalse();
    document.pages[0].content.blocks.blocks = [];
    expect(await service.hasUnsavedChanges()).toBeTrue();
  });
  it('keeps UI clean distinct from the strict saved-ABI evidence required by library removal', async () => {
    const original = structuredClone(document), originalDisk = disk;
    editor.getProjectUsedLibraryManifest = () => ({ 'lib-from-other-page': {}, 'lib-from-shared-procedure': {} });
    document.pages[0].content.blocks.blocks[0].extraState = { hasElse: true };
    service.rememberLoadedProject('D:/project', disk, original);
    expect(await service.hasUnsavedChanges()).toBeFalse();
    const revision = await service.getAbiRevisionSnapshot();
    expect(revision.scope).toBe('normalized-materialized-project-abi');
    expect(revision.changed).toBeTrue(); expect(revision.memoryHash).not.toBe(revision.diskHash);
    expect(revision.usedLibraries).toEqual(['lib-from-other-page', 'lib-from-shared-procedure']);
    expect(disk).toBe(originalDisk);
    disk = JSON.stringify(document); spyOn(service, 'syncUsedLibraryManifest').and.returnValue(false);
    await service.publishPreparedSaveOutputs('D:/project', { abiText: disk, documentText: disk }, null, () => {});
    expect(await service.hasUnsavedChanges()).toBeFalse();
    const saved = await service.getAbiRevisionSnapshot();
    expect(saved.changed).toBeFalse(); expect(saved.memoryHash).toBe(saved.diskHash);
  });
  it('resolves a cold cache without creating a baseline from a changed document', async () => {
    const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`, codec: 'utf8-v1',
      logicalType: 'text', storage: 'raw-v1', rawLength: 7, storedLength: 7 } } as const;
    document.pages[0].content.blocks.blocks[0].fields.TEST = 'payload';
    const external = structuredClone(document); external.pages[0].content.blocks.blocks[0].fields.TEST = createAilyProjectDataValue(ref);
    disk = JSON.stringify(external);
    spyOn(projectDataRuntime, 'resolve').and.resolveTo('payload');
    expect(await service.hasUnsavedChanges()).toBeFalse();
    document.pages[0].content.blocks.blocks[0].fields.TEST = 'edit';
    expect(await service.hasUnsavedChanges()).toBeTrue();
    expect(projectDataRuntime.getPrepared).not.toHaveBeenCalled();
    (projectDataRuntime.resolve as jasmine.Spy).and.rejectWith(new Error('missing resource'));
    await expectAsync(service.hasUnsavedChanges()).toBeRejectedWithError('missing resource');
  });
  for (const [fault, change] of [
    ['deleted block', d => d.pages[0].content.blocks.blocks = []],
    ['rejected field', d => d.pages[0].content.blocks.blocks[0].fields.TEST = 'wrong'],
    ['changed protection', d => d.pages[0].content.blocks.blocks[0].deletable = true],
    ['unexpected variable', d => d.sharedModel.variables = [{ id: 'unrequested', name: 'lost' }]],
  ] as Array<[string, (value: any) => void]>) it(`propagates ${fault} admission failure to activation and later dirty checks`, async () => {
    const original = structuredClone(document); change(document);
    expect(() => service.rememberLoadedProject('D:/project', disk, original)).toThrow();
    await expectAsync(service.hasUnsavedChanges()).toBeRejected();
  });
  it('does not erase a current baseline when a stale load caller arrives', async () => {
    service.rememberLoadedProject('D:/project', disk, structuredClone(document));
    expect(() => service.rememberLoadedProject('D:/old', disk, document)).toThrowError(/changed/);
    expect(await service.hasUnsavedChanges()).toBeFalse();
  });
  for (const loaded of [false, true]) it(`keeps cold, hot, explicitly cleared and LRU-evicted resources equivalent (loaded=${loaded})`, async () => {
    // A small test-only cache exercises real eviction without allocating 128 MB.
    const runtime: any = new (projectDataRuntime.constructor as any)();
    runtime.maxPreparedBytes = 8; runtime.sessionId = 'cache-test';
    const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`, codec: 'utf8-v1',
      logicalType: 'text', storage: 'raw-v1', rawLength: 6, storedLength: 6 } } as const;
    const other = { $ailyData: { ...ref.$ailyData, id: `sha256:${'b'.repeat(64)}` } };
    runtime.store = { resolve: jasmine.createSpy('read').and.resolveTo('中文') };
    spyOn(projectDataRuntime, 'resolve').and.callFake(ref => runtime.resolve(ref));
    const put = spyOn(projectDataRuntime, 'put').and.throwError('Dirty check must not create resources');
    document.pages[0].content.blocks.blocks[0].fields.TEST = '中文';
    const external = structuredClone(document);
    external.pages[0].content.blocks.blocks[0].fields.TEST = createAilyProjectDataValue(ref);
    disk = JSON.stringify(external); const diskBefore = disk;
    if (loaded) service.rememberLoadedProject('D:/project', disk, structuredClone(document));
    expect(await service.hasUnsavedChanges()).toBeFalse();
    await runtime.resolve(ref); expect(runtime.getPrepared(ref)).toBe('中文');
    expect(await service.hasUnsavedChanges()).toBeFalse();
    runtime.clearPrepared(); expect(() => runtime.getPrepared(ref)).toThrow();
    expect(await service.hasUnsavedChanges()).toBeFalse();
    await runtime.resolve(ref); await runtime.resolve(other);
    expect(() => runtime.getPrepared(ref)).toThrow(); expect(runtime.getPrepared(other)).toBe('中文');
    expect(await service.hasUnsavedChanges()).toBeFalse();
    document.pages[0].content.blocks.blocks[0].fields.TEST = 'modified';
    expect(await service.hasUnsavedChanges()).toBeTrue();
    expect(put).not.toHaveBeenCalled(); expect(disk).toBe(diskBefore);
  });
  it('acknowledges only the saved snapshot and preserves edits after the commit', async () => {
    service.rememberLoadedProject('D:/project', disk, structuredClone(document));
    document.pages[1].title = 'saved'; disk = JSON.stringify(document);
    spyOn(service, 'syncUsedLibraryManifest').and.returnValue(false);
    await service.publishPreparedSaveOutputs('D:/project', { abiText: disk, documentText: disk }, null, () => {});
    expect(await service.hasUnsavedChanges()).toBeFalse();
    document.pages[1].title = 'new edit'; expect(await service.hasUnsavedChanges()).toBeTrue();
    await expectAsync(service.publishPreparedSaveOutputs('D:/project', { abiText: 'other', documentText: disk }, null, () => {}))
      .toBeRejectedWithError(/stale/);
    expect(await service.hasUnsavedChanges()).toBeTrue();
  });
  it('does not accept a different disk revision between migration and load completion', async () => {
    const opened = disk; disk = JSON.stringify({ external: true });
    expect(() => service.rememberLoadedProject('D:/project', opened, document)).toThrowError(/changed during loading/);
    await expectAsync(service.hasUnsavedChanges()).toBeRejectedWithError(/changed during loading/);
  });

  for (const phase of ['disk', 'revision', 'project', 'page', 'runtime']) {
    it(`rejects a ${phase} change during the fallback resource read without publishing a baseline`, async () => {
      let session = 'original'; spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
      const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`, codec: 'utf8-v1',
        logicalType: 'text', storage: 'raw-v1', rawLength: 4, storedLength: 4 } } as const;
      const external = structuredClone(document);
      external.pages[0].content.blocks.blocks[0].fields.TEST = createAilyProjectDataValue(ref);
      disk = JSON.stringify(external);
      spyOn(projectDataRuntime, 'resolve').and.callFake(async <T>() => {
        if (phase === 'disk') disk = '{"external":true}';
        if (phase === 'revision') revision++;
        if (phase === 'project') service.currentProjectPath = 'D:/other';
        if (phase === 'page') document.activePageId = 'other';
        if (phase === 'runtime') session = 'replacement';
        return 'kept' as T;
      });
      await expectAsync(service.hasUnsavedChanges()).toBeRejectedWithError(/changed/);
    });
  }
});

describe('project check feedback is fail-closed for all editors', () => {
  const adapter = (result: any) => {
    const a: any = Object.create(ProjectApplicationAdapter.prototype);
    a.projectService = { currentProjectPath: 'D:/project' };
    a.actionService = { dispatch: (_type, _payload, callback) => callback(result) };
    return a as ProjectApplicationAdapter;
  };
  for (const flag of [true, false]) it(`keeps the existing boolean result ${flag}`, async () => {
    expect(await adapter({ success: true, data: { hasUnsavedChanges: flag } }).hasUnsavedBlocklyChanges()).toBe(flag);
  });
  for (const result of [{ success: false, error: 'timeout' }, { success: true },
    { success: true, data: { hasUnsavedChanges: Promise.resolve(false) } }]) it('rejects missing, failed or unawaited feedback', async () => {
      await expectAsync(adapter(result).hasUnsavedBlocklyChanges()).toBeRejected();
    });
  it('keeps the project open instead of showing a save dialog when checking fails', async () => {
    const h: any = Object.create(HeaderComponent.prototype);
    h.projectService = { getProjectMode: () => 'blockly', captureCurrentProjectGuard: () => () => true,
      hasUnsavedChanges: async () => { throw new Error('unavailable'); } };
    h.message = { error: jasmine.createSpy('error') }; h.modal = { create: jasmine.createSpy('dialog') };
    for (const action of ['close', 'open', 'new']) expect(await h.checkUnsavedChanges(action)).toBeFalse();
    expect(h.modal.create).not.toHaveBeenCalled(); expect(h.message.error).toHaveBeenCalled();
  });
  it('keeps the new-project wizard on the current project after a check failure', async () => {
    const wizard: any = Object.create(ProjectNewComponent.prototype);
    wizard.isOnEditorRoute = () => true;
    wizard.projectService = { captureCurrentProjectGuard: () => () => true,
      hasUnsavedChanges: async () => { throw new Error('unavailable'); } };
    wizard.message = { error: jasmine.createSpy('error') }; wizard.nzModal = { create: jasmine.createSpy('dialog') };
    expect(await wizard.confirmSwitchWithUnsavedIfNeeded()).toBeFalse();
    expect(wizard.nzModal.create).not.toHaveBeenCalled(); expect(wizard.message.error).toHaveBeenCalled();
  });
});

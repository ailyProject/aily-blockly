import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { projectBuildDocument } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { createAilyProjectDataValue, projectDataRuntime, AilyDataRef } from '@domain/project/public-api';

describe('saved ABI revision resource resolution', () => {
  const ref: AilyDataRef = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
    codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: 7, storedLength: 7 } };
  let oldFs: unknown; let disk: string; let revision: number; let session: string; let service: _ProjectService;
  beforeEach(() => {
    oldFs = window['fs']; disk = JSON.stringify({ field: createAilyProjectDataValue(ref) }); revision = 0; session = 'first';
    window['fs'] = { readFileSync: () => disk };
    service = new _ProjectService({ workspace: {}, getActivePageId: () => 'main',
      captureProjectSnapshot: () => ({ revision }), getProjectAbiForSave: () => ({ field: 'payload' }),
      getProjectUsedLibraryManifest: () => ({}),
      normalizeProjectAbi: value => value } as any, {} as any, {} as any);
    service.currentProjectPath = 'D:/project';
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'resolve').and.resolveTo('payload');
    spyOn(projectDataRuntime, 'getPrepared').and.throwError('cold cache');
  });
  afterEach(() => { window['fs'] = oldFs; });
  it('resolves a cold/evicted resource without requiring a synchronous prepared cache', async () => {
    const result = await service.getAbiRevisionSnapshot();
    expect(result.changed).toBeFalse(); expect(result.memoryHash).toBe(result.diskHash);
    expect(projectDataRuntime.getPrepared).not.toHaveBeenCalled();
    expect(projectDataRuntime.resolve).toHaveBeenCalledWith(ref);
  });
  it('does a bounded number of whole-project reads regardless of resource count', async () => {
    const editor = (service as any).blocklyService;
    const snapshots = spyOn(editor, 'captureProjectSnapshot').and.callThrough();
    const reads = spyOn(window['fs'], 'readFileSync').and.callThrough();
    disk = JSON.stringify({ fields: Array.from({ length: 12 }, () => createAilyProjectDataValue(ref)) });
    editor.getProjectAbiForSave = () => ({ fields: Array(12).fill('payload') });
    expect((await service.getAbiRevisionSnapshot()).changed).toBeFalse();
    expect(projectDataRuntime.resolve).toHaveBeenCalledTimes(12);
    expect(snapshots.calls.count()).toBeLessThanOrEqual(3);
    expect(reads.calls.count()).toBeLessThanOrEqual(3);
  });
  for (const phase of ['disk', 'revision', 'runtime']) {
    it(`rejects ${phase} changes during asynchronous materialization`, async () => {
      (projectDataRuntime.resolve as jasmine.Spy).and.callFake(async () => {
        if (phase === 'disk') disk = '{"external":true}';
        else if (phase === 'revision') revision++;
        else session = 'second';
        return 'payload';
      });
      await expectAsync(service.getAbiRevisionSnapshot()).toBeRejectedWithError(/changed/);
    });
  }

  function buildDocument() {
    const editor = (service as any).blocklyService;
    const saved = { pages: [{ id: 'main', content: { field: createAilyProjectDataValue(ref) },
      viewState: { scale: 1, scrollX: 0, scrollY: 0 } }] };
    const live = { pages: [{ ...saved.pages[0], content: { field: 'payload' }, viewState: { ...saved.pages[0].viewState } }] };
    disk = JSON.stringify(saved);
    editor.captureProjectSnapshot = () => ({ revision, document: live });
    editor.captureBuildSnapshot = () => ({ revision: live.pages[0].content.field === 'payload' ? 0 : 1,
      document: projectBuildDocument(live as any) });
    editor.readAfterWorkspaceEdit = (read: () => unknown) => read();
    editor.getProjectAbiForSave = (document: unknown) => document;
    return { saved, live };
  }

  it('ignores canvas pan and zoom for firmware while reporting an unsaved persisted viewport', async () => {
    const { live } = buildDocument();
    live.pages[0].viewState = { scale: 0.5, scrollX: 42, scrollY: -10 };
    expect((await service.getAbiRevisionSnapshot()).changed).toBeTrue();
    expect(await service.hasUnsavedBuildChanges()).toBeFalse();
    live.pages[0].content.field = 'updated program value';
    expect(await service.hasUnsavedBuildChanges()).toBeTrue();
  });

  it('accepts a viewport-only autosave during firmware verification', async () => {
    const { live, saved } = buildDocument();
    (projectDataRuntime.resolve as jasmine.Spy).and.callFake(async () => {
      live.pages[0].viewState = { scale: 0.5, scrollX: 42, scrollY: -10 };
      saved.pages[0].viewState = { ...live.pages[0].viewState };
      revision++;
      disk = JSON.stringify(saved);
      return 'payload';
    });
    expect(await service.hasUnsavedBuildChanges()).toBeFalse();
  });

  for (const change of ['disk', 'canvas']) {
    it(`rejects concurrent program edits in the ${change} during firmware verification`, async () => {
      const { live, saved } = buildDocument();
      (projectDataRuntime.resolve as jasmine.Spy).and.callFake(async () => {
        if (change === 'disk') disk = JSON.stringify({ ...saved, changed: 'program' });
        else live.pages[0].content.field = 'updated program value';
        return 'payload';
      });
      await expectAsync(service.hasUnsavedBuildChanges()).toBeRejectedWithError(/changed/);
    });
  }
});

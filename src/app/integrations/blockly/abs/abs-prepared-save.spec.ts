import { prepareBlocklySave, commitPreparedBlocklySave, PreparedBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { projectDataRuntime, ProjectDataStore, materializeGenericProjectDataValues, materializePreparedGenericProjectDataValues } from '@domain/project/public-api';
import { SerialOperationQueue } from '@shared/public-api';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { hashAbsText } from './abs-identity-map';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';

describe('prepared Blockly save boundary', () => {
  const document = () => ({ schemaVersion: 1, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'Main', content: { blocks: { blocks: [] } } }, { id: 'other', title: 'Other', content: {} }],
    sharedModel: { procedureBlocks: [] } });
  let disk: Map<string, string>;
  let files: any;
  const prepared: PreparedBlocklySave = { abiText: '{"saved":true}', documentText: '{}' };
  beforeEach(() => {
    disk = new Map([['D:/project/project.abi', 'original']]);
    files = {
      existsSync: path => disk.has(path), readFileSync: path => disk.get(path),
      writeFileSync: jasmine.createSpy('write').and.callFake((path, content) => disk.set(path, content)),
      replaceProjectText: jasmine.createSpy('publish').and.callFake(async (request, assertCurrent) => {
        const path = `${request.projectPath}/${request.fileName}`;
        const hash = await hashAbsText(request.content);
        const previous = disk.get(path) ?? null;
        const expected = previous === null ? null : await hashAbsText(previous);
        try {
          assertCurrent();
          if (expected !== request.expectedHash) return { status: 'CONFLICT', error: 'external edit' };
          files.writeFileSync(path, request.content);
          return { status: 'COMMITTED', hash };
        } catch (error) { return { status: 'NOT_COMMITTED', error: error.message }; }
      }),
    };
  });
  it('captures a detached document once and returns immutable prepared bytes', async () => {
    const source = document();
    const store = { collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }) };
    const runtime = { flushPending: async () => { source.pages[1].title = 'later edit'; }, getStore: () => store } as any;
    const result = await prepareBlocklySave(source, value => value, () => undefined, runtime);
    expect(JSON.parse(result.abiText).pages[1].title).toBe('Other');
    expect(JSON.parse(result.documentText).pages[1].title).toBe('Other');
    expect(Object.isFrozen(result)).toBeTrue();
  });
  it('stops after asynchronous validation when the source revision changes', async () => {
    let current = true;
    const runtime = { flushPending: async () => undefined, getStore: () => ({ collectReferences: () => [],
      validateReferences: async () => { current = false; return { valid: true, issues: [] }; } }) } as any;
    await expectAsync(prepareBlocklySave(document(), value => value, () => { if (!current) throw new Error('stale'); }, runtime)).toBeRejectedWithError('stale');
  });
  it('saves inactive-page serializer resources and restores them for loading/dirty comparison', async () => {
    const source = document();
    const payload = { modelId: 'opaque', records: ['😀'.repeat(10000)] };
    source.pages[1].content = { serializer: payload } as any;
    const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`, codec: 'canonical-json-v1',
      logicalType: 'json', storage: 'raw-v1', rawLength: 40000, storedLength: 40000 } };
    const store = { collectReferences: ProjectDataStore.prototype.collectReferences,
      validateReferences: jasmine.createSpy('validate').and.resolveTo({ valid: true, issues: [] }) };
    const runtime = { put: jasmine.createSpy('put').and.resolveTo(ref), flushPending: async () => undefined, getStore: () => store } as any;
    const result = await prepareBlocklySave(source, value => value, () => undefined, runtime);
    expect(result.abiText.length).toBeLessThan(2000);
    expect(store.validateReferences).toHaveBeenCalledOnceWith([ref]);
    await commitPreparedBlocklySave('D:/project', result, 'original', files, () => undefined);
    const saved = JSON.parse(disk.get('D:/project/project.abi')!);
    expect(await materializeGenericProjectDataValues(saved, { resolve: async () => payload as any })).toEqual(source);
    expect(materializePreparedGenericProjectDataValues(saved, () => payload)).toEqual(source);
    expect(JSON.parse(result.documentText)).toEqual(source);
  });
  it('stops before another resource write if the source changes between oversized payloads', async () => {
    let current = true;
    const source = document();
    source.pages[1].content = { first: 'x'.repeat(40000), second: 'y'.repeat(40000) } as any;
    const put = jasmine.createSpy('put').and.callFake(async () => { current = false; return {}; });
    const runtime = { put } as any;
    await expectAsync(prepareBlocklySave(source, value => value, () => { if (!current) throw new Error('stale'); }, runtime)).toBeRejectedWithError('stale');
    expect(put).toHaveBeenCalledTimes(1);
  });
  it('commits exact prepared bytes without calling a workspace serializer', async () => {
    await commitPreparedBlocklySave('D:/project', prepared, 'original', files, () => undefined);
    expect(disk.get('D:/project/project.abi')).toBe(prepared.abiText);
    expect(disk.size).toBe(1);
  });
  it('retains concurrent ABI edits when the host rejects the expected hash', async () => {
    await expectAsync(commitPreparedBlocklySave('D:/project', prepared, 'older', files, () => undefined)).toBeRejected();
    expect(files.writeFileSync).not.toHaveBeenCalled();
    files.replaceProjectText.and.callFake(async () => { disk.set('D:/project/project.abi', 'external edit'); return { status: 'CONFLICT' }; });
    await expectAsync(commitPreparedBlocklySave('D:/project', prepared, 'original', files, () => undefined)).toBeRejected();
    expect(disk.get('D:/project/project.abi')).toBe('external edit');
    expect(disk.size).toBe(1);
  });
  it('leaves filesystem cleanup to the host when publication fails', async () => {
    disk.set('D:/project/project.abi.another.tmp', 'another operation');
    files.replaceProjectText.and.resolveTo({ status: 'NOT_COMMITTED', error: 'disk failure' });
    await expectAsync(commitPreparedBlocklySave('D:/project', prepared, 'original', files, () => undefined)).toBeRejectedWithError('disk failure');
    expect(disk.get('D:/project/project.abi')).toBe('original');
    expect(disk.get('D:/project/project.abi.another.tmp')).toBe('another operation');
    expect(disk.size).toBe(2);
  });
  it('accepts an exact host commit acknowledgement with cleanup warnings', async () => {
    files.replaceProjectText.and.callFake(async () => {
      disk.set('D:/project/project.abi', prepared.abiText);
      return { status: 'COMMITTED', hash: await hashAbsText(prepared.abiText), warnings: ['cleanup pending'] };
    });
    expect((await commitPreparedBlocklySave('D:/project', prepared, 'original', files, () => undefined)).warnings).toEqual(['cleanup pending']);
    expect(disk.get('D:/project/project.abi')).toBe(prepared.abiText);
    expect(disk.size).toBe(1);
  });

  describe('current product save entry', () => {
    let service: _ProjectService;
    let editor: any;
    let source: ReturnType<typeof document>;
    let oldFiles: unknown;
    beforeEach(() => {
      oldFiles = window['fs']; window['fs'] = files;
      source = document();
      const operations = new SerialOperationQueue();
      const gate = new BlocklyWorkspaceEditGate();
      const revision = new BlocklyProjectRevision();
      editor = { workspace: {}, getActivePageId: () => source.activePageId,
        prepareProjectCode: jasmine.createSpy('prepareCode').and.resolveTo(null),
        runProjectOperation: operation => operations.run(() => { gate.assertAvailable(); return operation(); }),
        acquireWorkspaceEditLease: () => gate.acquire(), isWorkspaceEditBlocked: () => gate.blocked,
        captureProjectSnapshot: () => ({ document: editor.getProjectDocument(), revision: revision.observe(editor.getProjectDocument()) }),
        getProjectDocument: () => JSON.parse(JSON.stringify(source)), getProjectAbiForSave: value => value };
      service = new _ProjectService(editor, {} as any, {} as any);
      service.currentProjectPath = 'D:/project';
      spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
      spyOn(service, 'prepareSave').and.callFake(async value => ({ abiText: JSON.stringify(value), documentText: JSON.stringify(value) }));
      spyOn(service, 'syncUsedLibraryManifest').and.returnValue(false);
      spyOn(service as any, 'publishPreparedCode').and.resolveTo();
    });
    afterEach(() => { window['fs'] = oldFiles; });
    it('detects edits to other pages even without a generated-code revision change', async () => {
      (service.prepareSave as jasmine.Spy).and.callFake(async value => {
        source.pages[1].title = 'changed';
        return { abiText: JSON.stringify(value), documentText: JSON.stringify(value) };
      });
      await expectAsync(service.save('D:/project')).toBeRejected();
      expect(files.writeFileSync).not.toHaveBeenCalled();
    });
    it('prepares models under edit ownership before sealing ABI, then publishes only that result', async () => {
      let generated;
      editor.prepareProjectCode.and.callFake(async (assertCurrent, lease) => {
        assertCurrent(); lease.assertCurrent(); expect(editor.isWorkspaceEditBlocked()).toBeTrue();
        source.sharedModel['variables'] = [{ name: 'device', type: 'runtime-type', id: 'model' }];
        generated = Object.freeze({ code: 'prepared code', artifacts: null, blockCodeMapText: null, revision: editor.captureProjectSnapshot().revision });
        return generated;
      });
      await service.save('D:/project');
      expect(JSON.parse(disk.get('D:/project/project.abi')!).sharedModel.variables).toEqual(source.sharedModel['variables']);
      expect((service as any).publishPreparedCode).toHaveBeenCalledOnceWith('D:/project', generated, jasmine.any(Function));
      expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    });
    it('stops before ABI publication and releases ownership after a preparation conflict', async () => {
      editor.prepareProjectCode.and.rejectWith(new Error('stale generation'));
      await expectAsync(service.save('D:/project')).toBeRejectedWithError('stale generation');
      expect(files.replaceProjectText).not.toHaveBeenCalled();
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    });
    it('retains an external ABI edit made during code preparation', async () => {
      editor.prepareProjectCode.and.callFake(async () => { disk.set('D:/project/project.abi', 'external edit'); return null; });
      await expectAsync(service.save('D:/project')).toBeRejected();
      expect(disk.get('D:/project/project.abi')).toBe('external edit');
      expect(files.writeFileSync).not.toHaveBeenCalled();
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    });
    it('rejects source changes between a prepared result and the save continuation', async () => {
      editor.prepareProjectCode.and.callFake(async () => {
        const revision = editor.captureProjectSnapshot().revision;
        queueMicrotask(() => { source.pages[1].title = 'late edit'; });
        return { code: 'old code', artifacts: null, blockCodeMapText: null, revision };
      });
      await expectAsync(service.save('D:/project')).toBeRejectedWithError(/changed after code preparation/);
      expect(files.replaceProjectText).not.toHaveBeenCalled();
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    });
    it('still saves editable ABI when generation fails, without attempting a second generation', async () => {
      editor.prepareProjectCode.and.resolveTo({ code: null, artifacts: null, blockCodeMapText: null, error: 'unfinished code', revision: editor.captureProjectSnapshot().revision });
      (service as any).publishPreparedCode.and.callThrough();
      await service.save('D:/project');
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
      expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    });
    it('rejects stale queued saves after switching project/page', async () => {
      const pending = service.save('D:/project');
      source.activePageId = 'other';
      await expectAsync(pending).toBeRejected();
      expect(files.writeFileSync).not.toHaveBeenCalled();
    });
    it('serializes normal saves and continues after a failed preparation', async () => {
      (service.prepareSave as jasmine.Spy).and.rejectWith(new Error('preflight failed'));
      await expectAsync(service.save('D:/project')).toBeRejectedWithError('preflight failed');
      (service.prepareSave as jasmine.Spy).and.callFake(async value => ({ abiText: JSON.stringify(value), documentText: JSON.stringify(value) }));
      await Promise.all([service.save('D:/project'), service.save('D:/project')]);
      expect(files.replaceProjectText).toHaveBeenCalledTimes(2);
      expect(service.syncUsedLibraryManifest).toHaveBeenCalledTimes(2);
    });
    it('rejects a Project Data session change during preparation', async () => {
      let session = 'first';
      spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
      (service.prepareSave as jasmine.Spy).and.callFake(async value => {
        session = 'second'; return { abiText: JSON.stringify(value), documentText: JSON.stringify(value) };
      });
      await expectAsync(service.save('D:/project')).toBeRejected();
      expect(files.writeFileSync).not.toHaveBeenCalled();
    });
    it('does not report the committed ABI as rolled back when context changes immediately after commit', async () => {
      files.writeFileSync.and.callFake((path, content) => { disk.set(path, content); source.activePageId = 'other'; });
      await expectAsync(service.save('D:/project')).toBeResolved();
      expect(JSON.parse(disk.get('D:/project/project.abi')!).activePageId).toBe('main');
      expect(service.syncUsedLibraryManifest).not.toHaveBeenCalled();
    });
    it('quarantines the current workspace after an uncertain ABI publication', async () => {
      files.replaceProjectText.and.resolveTo({ status: 'UNKNOWN', error: 'lost acknowledgement' });
      await expectAsync(service.save('D:/project')).toBeRejectedWith(jasmine.objectContaining({ uncertain: true }));
      expect(editor.isWorkspaceEditBlocked()).toBeTrue();
      expect(service.syncUsedLibraryManifest).not.toHaveBeenCalled();
      await expectAsync(service.save('D:/project')).toBeRejected();
    });
    it('retains the uncertain result without quarantining a new page', async () => {
      files.replaceProjectText.and.callFake(async () => {
        source.activePageId = 'other'; return { status: 'UNKNOWN', error: 'lost acknowledgement' };
      });
      await expectAsync(service.save('D:/project')).toBeRejectedWith(jasmine.objectContaining({ uncertain: true }));
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
      expect(service.syncUsedLibraryManifest).not.toHaveBeenCalled();
    });
  });
});

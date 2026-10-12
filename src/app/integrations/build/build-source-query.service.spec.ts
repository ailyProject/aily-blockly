import { BehaviorSubject, Subject } from 'rxjs';
import { BuildSourceQueryService } from './build-source-query.service';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { _ProjectService as BlocklyEditorProjectService } from '../../editors/blockly-editor/services/project.service';
import { AbsWorkspaceSyncService } from '../blockly/abs/abs-workspace-sync.service';
import { hashAbsText } from '../blockly/abs/abs-identity-map';
import { sha256Hex } from '../../utils/crypto.utils';

describe('Read-only live build source query', () => {
  const root = '/projects/current';
  let previousPath: any, previousIpc: any, previousFs: any, service: BuildSourceQueryService;
  let project: any, blockly: any, coder: any, editorProject: any, abs: any, electron: any, ipc: any, listener: Function;
  let disk: Map<string, Uint8Array>, states: Map<string, any>, fs: any;
  beforeEach(() => {
    previousPath = window['path']; previousIpc = window['ipcRenderer']; previousFs = window['fs'];
    window['path'] = { relative: (a: string, b: string) => a === b ? '' : '../other', join: (...parts: string[]) => parts.join('/') };
    disk = new Map([[`${root}/project.abi`, new TextEncoder().encode('{"saved":"真实工程"}')]]);
    states = new Map();
    fs = { existsSync: (path: string) => disk.has(path),
      lstatSync: jasmine.createSpy('lstatSync').and.callFake((path: string) => {
        if (states.has(path)) return { ...states.get(path) };
        if (path !== root && !disk.has(path)) throw new Error('Missing saved source file');
        return { size: path === root ? 0 : disk.get(path)!.byteLength, mtime: 'current', birthtime: 'original',
          _isDirectory: path === root, _isFile: path !== root, _isSymbolicLink: false };
      }),
      readFileBuffer: jasmine.createSpy('readFileBuffer').and.callFake((path: string) => {
        if (!disk.has(path)) throw new Error('Missing saved source file');
        // Match the actual preload bridge: an owned raw ArrayBuffer, not its
        // readFileSync API's default UTF-8 string or a Node Buffer.
        return disk.get(path)!.slice().buffer;
      }),
      readFileSync: jasmine.createSpy('readFileSync').and.throwError('Text reads are not raw file facts'),
    };
    window['fs'] = fs;
    ipc = { on: jasmine.createSpy('on').and.callFake((_channel: string, fn: Function) => { listener = fn; }), send: jasmine.createSpy('send') };
    window['ipcRenderer'] = ipc;
    project = { currentProjectPath: root, currentProjectPath$: new BehaviorSubject(root), projectActivation$: new Subject(),
      isProjectTransitionInProgress: () => false, getProjectMode: () => 'blockly', getRuntimeBoardModule: () => 'board-test',
      getBoardModule: async () => 'board-test' };
    blockly = { workspace: {}, isWorkspaceEditInProgress: () => false, getActivePageId: () => 'main',
      captureProjectSnapshot: () => ({ document: { blocks: {} }, revision: 4 }) };
    coder = { hasSavedProject: jasmine.createSpy('hasSavedProject').and.resolveTo(true) };
    editorProject = { currentProjectPath: root, hasUnsavedChanges: jasmine.createSpy('hasUnsavedChanges').and.resolveTo(false) };
    abs = { inspectGeneration: jasmine.createSpy('inspectGeneration').and.callFake(async () => ({ pending: null,
      diagnostics: { status: 'ready', hashes: {
        abi: await hashAbsText(new TextDecoder().decode(disk.get(`${root}/project.abi`))),
        abs: await hashAbsText(new TextDecoder().decode(disk.get(`${root}/project.abs`))),
        map: await hashAbsText(new TextDecoder().decode(disk.get(`${root}/project.abs.map.json`))),
      }, workspace: { matchesSaved: true, changedFromBaseline: false, savedChangedFromBaseline: false } } })) };
    electron = { currentRendererGeneration: 3 };
    service = new BuildSourceQueryService(project, electron, {
      get: (token: unknown) => token === CodeEditorProProjectService ? coder
        : token === BlocklyEditorProjectService ? editorProject : token === AbsWorkspaceSyncService ? abs : blockly,
    } as any); service.initialize();
  });
  afterEach(() => { window['path'] = previousPath; window['ipcRenderer'] = previousIpc; window['fs'] = previousFs; });

  it('captures the active serialized document without generating or saving', async () => {
    const source: any = await service.read(root);
    expect(source.workspace.documentSha256).toBe(await sha256Hex('{"blocks":{}}'));
    expect(source.workspace.revision).toBe(4); expect(source.boardModule).toBe('board-test');
    expect(coder.hasSavedProject).not.toHaveBeenCalled();
    service.initialize(); expect(ipc.on).toHaveBeenCalledTimes(1);
  });
  for (const change of ['revision', 'page', 'workspace', 'activation', 'project', 'busy']) {
    it(`refuses ${change} drift while hashing`, async () => {
      const reading = service.read(root);
      if (change === 'revision') blockly.captureProjectSnapshot = () => ({ document: { blocks: {} }, revision: 5 });
      if (change === 'page') blockly.getActivePageId = () => 'other';
      if (change === 'workspace') blockly.workspace = {};
      if (change === 'activation') project.projectActivation$.next({});
      if (change === 'project') project.currentProjectPath = '/projects/other';
      if (change === 'busy') blockly.isWorkspaceEditInProgress = () => true;
      await expectAsync(reading).toBeRejected();
    });
  }
  it('changes activation identity after switching away and back', async () => {
    const before: any = await service.read(root);
    project.currentProjectPath$.next('/projects/other'); project.currentProjectPath$.next(root);
    const after: any = await service.read(root); expect(after.activationId).not.toBe(before.activationId);
  });
  it('refuses transitions, unknown editors and busy workspaces', async () => {
    project.isProjectTransitionInProgress = () => true; await expectAsync(service.read(root)).toBeRejected();
    project.isProjectTransitionInProgress = () => false; blockly.workspace = undefined;
    await expectAsync(service.read(root)).toBeRejected();
    project.getProjectMode = () => 'unsupported'; await expectAsync(service.read(root)).toBeRejected();
  });
  it('checks Coder dirty state after awaiting board configuration, without saving', async () => {
    project.getProjectMode = () => 'coder';
    project.getBoardModule = async () => { coder.hasSavedProject.and.resolveTo(false); return 'board-test'; };
    const source: any = await service.read(root); expect(source.saved).toBeFalse();
    expect(coder.hasSavedProject).toHaveBeenCalledOnceWith(root);
  });
  it('refuses switching during the Coder query', async () => {
    project.getProjectMode = () => 'coder';
    coder.hasSavedProject.and.callFake(async () => { project.projectActivation$.next({}); return true; });
    await expectAsync(service.read(root)).toBeRejected();
  });
  it('echoes correlation only for the current generation and rejects reload during query', async () => {
    const respond = () => new Promise<any>(resolve => ipc.send.and.callFake((_channel: string, result: any) => resolve(result)));
    let reply = respond(); listener(null, { requestId: 'old', rendererGeneration: 2, projectPath: root });
    expect((await reply).ok).toBeFalse();
    reply = respond(); listener(null, { requestId: 'current', rendererGeneration: 3, projectPath: root });
    expect(await reply).toEqual(jasmine.objectContaining({ ok: true, requestId: 'current', rendererGeneration: 3 }));
    reply = respond(); listener(null, { requestId: 'reload', rendererGeneration: 3, projectPath: root });
    electron.currentRendererGeneration++;
    expect((await reply).ok).toBeFalse();
  });

  describe('normal saved-project source boundary', () => {
    function addAbs() {
      disk.set(`${root}/project.abs`, new TextEncoder().encode('# ABS Schema: 2\nroot()\n'));
      disk.set(`${root}/project.abs.map.json`, new TextEncoder().encode('{"current":true}\n'));
    }

    it('captures raw ABI bytes with existing saved-state ownership without generating or saving', async () => {
      const result = await service.readSavedProjectBoundary(root);
      expect(result.workspace).toEqual(jasmine.objectContaining({ scope: 'serialized-blockly-document', revision: 4,
        documentSha256: await sha256Hex('{"blocks":{}}') }));
      expect(result.workspace.savedProjectFiles).toEqual([{ path: 'project.abi',
        sizeBytes: disk.get(`${root}/project.abi`)!.byteLength, sha256: await sha256Hex('{"saved":"真实工程"}') }]);
      expect(editorProject.hasUnsavedChanges).toHaveBeenCalledTimes(1);
      expect(abs.inspectGeneration).not.toHaveBeenCalled();
      expect(coder.hasSavedProject).not.toHaveBeenCalled();
      expect(Object.isFrozen(result.workspace.savedProjectFiles[0])).toBeTrue();
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('uses the existing ABS owner and records the exact ordered ABI/ABS/map facts', async () => {
      addAbs();
      const result = await service.readSavedProjectBoundary(root);
      expect(result.workspace.savedProjectFiles.map(file => file.path)).toEqual(['project.abi', 'project.abs', 'project.abs.map.json']);
      for (const file of result.workspace.savedProjectFiles) {
        const bytes = disk.get(`${root}/${file.path}`)!;
        expect(file.sizeBytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(await sha256Hex(new TextDecoder().decode(bytes)));
      }
      expect(abs.inspectGeneration).toHaveBeenCalledTimes(1);
    });

    it('accepts the existing owner ready state after legal load normalization differs from raw saved shape', async () => {
      addAbs();
      const initial = await abs.inspectGeneration();
      initial.diagnostics.workspace.matchesSaved = false;
      abs.inspectGeneration.and.resolveTo(initial);
      const result = await service.readSavedProjectBoundary(root);
      expect(result.workspace.savedProjectFiles.map(file => file.path)).toEqual(['project.abi', 'project.abs', 'project.abs.map.json']);
      expect(editorProject.hasUnsavedChanges).toHaveBeenCalledTimes(1);
      expect(initial.diagnostics.status).toBe('ready');
      expect(initial.diagnostics.workspace.changedFromBaseline).toBeFalse();
      expect(initial.diagnostics.workspace.savedChangedFromBaseline).toBeFalse();
    });

    it('leaves the ordinary live query free of saved-file/ABS requirements', async () => {
      editorProject.hasUnsavedChanges.and.resolveTo(true);
      addAbs(); disk.delete(`${root}/project.abs.map.json`);
      expect((await service.read(root) as any).workspace.savedProjectFiles).toBeUndefined();
      expect(editorProject.hasUnsavedChanges).not.toHaveBeenCalled();
      expect(abs.inspectGeneration).not.toHaveBeenCalled();
    });

    it('rejects dirty or unavailable saved-state owners without saving', async () => {
      editorProject.hasUnsavedChanges.and.resolveTo(true);
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/Save the current/);
      editorProject.hasUnsavedChanges.and.rejectWith(new Error('Saved state unavailable'));
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/Saved state unavailable/);
    });

    for (const missing of ['project.abi', 'project.abs', 'project.abs.map.json']) it(`rejects missing ${missing}`, async () => {
      addAbs(); disk.delete(`${root}/${missing}`);
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejected();
    });

    for (const problem of ['pending', 'draft', 'memory', 'abi', 'hash', 'bare-hash']) it(`rejects ABS ${problem} without deriving replacement facts`, async () => {
      addAbs();
      const initial = await abs.inspectGeneration();
      abs.inspectGeneration.and.callFake(async () => {
        const result = structuredClone(initial);
        if (problem === 'pending') result.pending = { generation: 'incomplete' };
        if (problem === 'draft') result.diagnostics.status = 'blocked';
        if (problem === 'memory') result.diagnostics.workspace.changedFromBaseline = true;
        if (problem === 'abi') result.diagnostics.workspace.savedChangedFromBaseline = true;
        if (problem === 'hash') result.diagnostics.hashes.abs = '0'.repeat(64);
        if (problem === 'bare-hash') for (const key of ['abi', 'abs', 'map']) result.diagnostics.hashes[key] = result.diagnostics.hashes[key].slice(7);
        return result;
      });
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/Reconcile the ABS/);
    });

    for (const change of ['revision', 'activation', 'editor', 'file', 'pair']) it(`rejects ${change} drift across saved-state await`, async () => {
      editorProject.hasUnsavedChanges.and.callFake(async () => {
        if (change === 'revision') blockly.captureProjectSnapshot = () => ({ document: { blocks: {} }, revision: 5 });
        if (change === 'activation') project.projectActivation$.next({});
        if (change === 'editor') editorProject.currentProjectPath = '/projects/other';
        if (change === 'file') disk.set(`${root}/project.abi`, new TextEncoder().encode('{"external":true}'));
        if (change === 'pair') addAbs();
        return false;
      });
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejected();
    });

    it('rejects a changed source byte during ABS verification', async () => {
      addAbs();
      const initial = await abs.inspectGeneration();
      abs.inspectGeneration.and.callFake(async () => {
        const result = structuredClone(initial);
        disk.get(`${root}/project.abi`)![0] ^= 1;
        return result;
      });
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/Saved project files changed/);
    });

    for (const file of ['project.abi', 'project.abs.map.json']) it(`checks the complete byte budget before allocating ${file}`, async () => {
      addAbs();
      states.set(`${root}/${file}`, { ...fs.lstatSync(`${root}/${file}`), size: 128 * 1024 * 1024 });
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/file\/byte boundary/);
      expect(fs.readFileBuffer).not.toHaveBeenCalled();
      expect(editorProject.hasUnsavedChanges).not.toHaveBeenCalled();
    });

    for (const invalid of ['link', 'directory', 'negative', 'fractional']) it(`rejects a saved-file ${invalid} before allocating`, async () => {
      const state = fs.lstatSync(`${root}/project.abi`);
      if (invalid === 'link') state._isSymbolicLink = true;
      if (invalid === 'directory') { state._isFile = false; state._isDirectory = true; }
      if (invalid === 'negative') state.size = -1;
      if (invalid === 'fractional') state.size = 1.5;
      states.set(`${root}/project.abi`, state);
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/file\/byte boundary/);
      expect(fs.readFileBuffer).not.toHaveBeenCalled();
    });

    for (const invalid of ['link', 'file']) it(`rejects a project-root ${invalid} before allocating`, async () => {
      const state = fs.lstatSync(root);
      if (invalid === 'link') state._isSymbolicLink = true;
      else { state._isDirectory = false; state._isFile = true; }
      states.set(root, state);
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/non-linked directory/);
      expect(fs.readFileBuffer).not.toHaveBeenCalled();
    });

    for (const change of ['size', 'mtime', 'replacement', 'link', 'root', 'buffer']) it(`rejects ${change} drift during the synchronous bridge read`, async () => {
      const read = fs.readFileBuffer;
      read.and.callFake((path: string) => {
        const bytes = disk.get(path)!.slice().buffer;
        const state = fs.lstatSync(change === 'root' ? root : path);
        if (change === 'size') state.size++;
        if (change === 'mtime') state.mtime = 'changed';
        if (change === 'replacement' || change === 'root') state.birthtime = 'replacement';
        if (change === 'link') state._isSymbolicLink = true;
        if (change !== 'buffer') states.set(change === 'root' ? root : path, state);
        return change === 'buffer' ? bytes.slice(1) : bytes;
      });
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/changed while reading/);
    });

    it('rejects unavailable raw/stat bridge methods without using text reads', async () => {
      delete fs.readFileBuffer;
      await expectAsync(service.readSavedProjectBoundary(root)).toBeRejectedWithError(/access is unavailable/);
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });
});

describe('Coder live persistence boundary', () => {
  const root = '/projects/coder';
  let service: CodeEditorProProjectService, bridge: any;
  beforeEach(() => {
    service = new CodeEditorProProjectService({} as any, {} as any, {} as any);
    bridge = { saveAll: jasmine.createSpy('saveAll'), hasUnsavedChanges: jasmine.createSpy('dirty').and.resolveTo(false) };
  });
  it('missing, dirty or unmounted editors are not known saved', async () => {
    expect(await service.hasSavedProject(root)).toBeFalse(); service.registerPersistenceBridge(root, bridge);
    expect(await service.hasSavedProject(root)).toBeTrue(); bridge.hasUnsavedChanges.and.resolveTo(true);
    expect(await service.hasSavedProject(root)).toBeFalse(); service.unregisterPersistenceBridge(root, bridge);
    expect(await service.hasSavedProject(root)).toBeFalse(); expect(bridge.saveAll).not.toHaveBeenCalled();
  });
  for (const action of ['unregister', 'replace']) it(`rejects a bridge ${action} while checking`, async () => {
    service.registerPersistenceBridge(root, bridge);
    bridge.hasUnsavedChanges.and.callFake(async () => {
      if (action === 'unregister') service.unregisterPersistenceBridge(root, bridge);
      else service.registerPersistenceBridge(root, { ...bridge });
      return false;
    });
    expect(await service.hasSavedProject(root)).toBeFalse(); expect(bridge.saveAll).not.toHaveBeenCalled();
  });
});

import { BehaviorSubject, Subject } from 'rxjs';
import { BuildSourceQueryService } from './build-source-query.service';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { sha256Hex } from '../../utils/crypto.utils';

describe('Read-only live build source query', () => {
  const root = '/projects/current';
  let previousPath: any, previousIpc: any, service: BuildSourceQueryService;
  let project: any, blockly: any, coder: any, electron: any, ipc: any, listener: Function;
  beforeEach(() => {
    previousPath = window['path']; previousIpc = window['ipcRenderer'];
    window['path'] = { relative: (a: string, b: string) => a === b ? '' : '../other' };
    ipc = { on: jasmine.createSpy('on').and.callFake((_channel: string, fn: Function) => { listener = fn; }), send: jasmine.createSpy('send') };
    window['ipcRenderer'] = ipc;
    project = { currentProjectPath: root, currentProjectPath$: new BehaviorSubject(root), projectActivation$: new Subject(),
      isProjectTransitionInProgress: () => false, getProjectMode: () => 'blockly', getRuntimeBoardModule: () => 'board-test',
      getBoardModule: async () => 'board-test' };
    blockly = { workspace: {}, isWorkspaceEditInProgress: () => false, getActivePageId: () => 'main',
      captureProjectSnapshot: () => ({ document: { blocks: {} }, revision: 4 }) };
    coder = { hasSavedProject: jasmine.createSpy('hasSavedProject').and.resolveTo(true) };
    electron = { currentRendererGeneration: 3 };
    service = new BuildSourceQueryService(project, electron, {
      get: (token: unknown) => token === CodeEditorProProjectService ? coder : blockly,
    } as any); service.initialize();
  });
  afterEach(() => { window['path'] = previousPath; window['ipcRenderer'] = previousIpc; });

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

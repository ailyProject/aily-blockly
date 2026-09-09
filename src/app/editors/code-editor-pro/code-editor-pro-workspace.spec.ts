import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { CodeEditorProComponent } from './code-editor-pro.component';
import { CodeEditorFrameComponent } from './code-editor-frame.component';
import { CodeEditorProProjectService } from './services/code-editor-pro-project.service';

describe('Coder retained project workspaces', () => {
  let service: any;
  let originals: any;
  beforeEach(() => {
    originals = { path: window['path'], fs: window['fs'], projectLock: window['projectLock'], ipcRenderer: window['ipcRenderer'] };
    window['path'] = {
      resolve: (path: string) => path.replace(/\/$/, ''), join: (...parts: string[]) => parts.join('/'),
      relative: (root: string, path: string) => path === root ? '' : path.startsWith(root + '/') ? path.slice(root.length + 1) : '../outside',
      isAbsolute: (path: string) => path.startsWith('/'),
    };
    window['fs'] = { isDirectory: () => true };
    window['ipcRenderer'] = { send: jasmine.createSpy('send') };
    window['projectLock'] = { tryAcquire: jasmine.createSpy('acquire').and.resolveTo({ ok: true }), release: jasmine.createSpy('release').and.resolveTo() };
    service = Object.create(ProjectService.prototype);
    Object.assign(service, {
      coderOperationSubject: new BehaviorSubject(null), coderOperationsSubject: new BehaviorSubject(new Map()),
      coderOperations: new Map(), coderProjectContexts: new Map(), coderProjectsSubject: new BehaviorSubject([]),
      currentProjectPathSubject: new BehaviorSubject(''), stateSubject: new BehaviorSubject('loaded'),
      boardConfigUpdatedSubject: new Subject(),
      getProjectMode: (path: string) => path.includes('device') ? 'coder' : 'blockly',
      isAilyCodeProject: (path: string) => path.includes('device'),
      electronService: { isElectron: true, exists: () => true, readFile: () => '{"name":"device","type":"coder"}', setTitle: jasmine.createSpy('title') },
    });
    service.currentProjectPath = '/work/device-a';
  });
  afterEach(() => Object.assign(window, originals));

  it('adds projects without activating them and rejects non-Coder directories', async () => {
    await service.addCoderProject('/work/device-b');
    await service.addCoderProject('/work/device-b/');
    expect(service.coderProjects.length).toBe(2);
    expect(service.currentProjectPath).toBe('/work/device-a');
    expect(window['projectLock'].tryAcquire).toHaveBeenCalledTimes(1);
    await expectAsync(service.addCoderProject('/work/blocks')).toBeRejected();
  });

  it('creates stable project contexts whose path and metadata do not change on tab activation', () => {
    const a = service.getCoderProjectContext('/work/device-a');
    const b = service.getCoderProjectContext('/work/device-b');
    b.currentPackageData = { name: 'B' };
    service.currentProjectPath = '/work/device-b';
    expect(service.getCoderProjectContext('/work/device-a')).toBe(a);
    expect(a.currentProjectPath).toBe('/work/device-a');
    expect(a.currentPackageData.name).toBe('device');
    expect(b.currentPackageData.name).toBe('B');
    expect(a.stateSubject).not.toBe(b.stateSubject);
  });

  it('isolates each retained iframe filesystem to its own root', () => {
    const a: any = Object.create(CodeEditorFrameComponent.prototype);
    const b: any = Object.create(CodeEditorFrameComponent.prototype);
    a.coderEmbedWorkspaceRoot = '/work/device-a'; b.coderEmbedWorkspaceRoot = '/work/device-b';
    service.currentProjectPath = '/work/device-b';
    expect(a.assertPathInsideCoderEmbedRoot('/work/device-a/main.cpp')).toBe('/work/device-a/main.cpp');
    expect(() => a.assertPathInsideCoderEmbedRoot('/work/device-b/main.cpp')).toThrow();
    expect(() => b.assertPathInsideCoderEmbedRoot('/work/device-a/main.cpp')).toThrow();
  });

  it('tracks overlapping uploads and builds by project and restores nested upload state', () => {
    const finishUpload = service.beginCoderOperation('upload', '/work/device-a');
    const finishB = service.beginCoderOperation('build', '/work/device-b');
    const finishNested = service.beginCoderOperation('build', '/work/device-a');
    expect(service.coderOperationsSubject.value.size).toBe(2);
    finishNested();
    expect(service.getCoderOperation('/work/device-a').kind).toBe('upload');
    finishB();
    expect(service.getCoderOperation('/work/device-b')).toBeNull();
    expect(service.getCoderOperation('/work/device-a').kind).toBe('upload');
    finishUpload();
    expect(service.coderOperationsSubject.value.size).toBe(0);
  });

  it('allows switching during a background operation without saving or unloading its editor', async () => {
    service.beginCoderOperation('upload', '/work/device-a');
    service.ensureProjectModeAllowed = async () => true;
    service.configService = { getApplicationName: () => 'Coder' };
    service.routerService = { navigate: jasmine.createSpy('navigate').and.resolveTo(true) };
    service.projectActivationSubject = new Subject();
    Object.defineProperty(service, 'application', { value: { dispatchProjectSave: jasmine.createSpy('save') } });
    const b = service.getCoderProjectContext('/work/device-b');
    b.syncCurrentBoardConfig = async () => true;
    expect(await service.projectOpen('/work/device-b')).toBeTrue();
    expect(service.currentProjectPath).toBe('/work/device-b');
    expect(service.application.dispatchProjectSave).not.toHaveBeenCalled();
    expect(service.getCoderOperation('/work/device-a').kind).toBe('upload');
    expect(window['projectLock'].release).not.toHaveBeenCalled();
  });

  it('saves only the closing project before destroying its iframe', async () => {
    await service.addCoderProject('/work/device-b');
    const component: any = Object.create(CodeEditorProComponent.prototype);
    component.projectService = service;
    component.closing = new Set();
    component.persistence = { saveAll: jasmine.createSpy('save').and.resolveTo() };
    component.message = { error: jasmine.createSpy('error') };
    await component.closeCoderProject('/work/device-b', new Event('click'));
    expect(component.persistence.saveAll).toHaveBeenCalledOnceWith('/work/device-b');
    expect(service.coderProjects.length).toBe(1);
    expect(service.currentProjectPath).toBe('/work/device-a');
  });

  it('routes simultaneous saves to their matching iframe and includes inactive dirty editors when closing', async () => {
    const persistence = new CodeEditorProProjectService({} as any, service);
    let finishA!: (value: { ok: boolean }) => void;
    const a = { saveAll: jasmine.createSpy('saveA').and.returnValue(new Promise(resolve => finishA = resolve)), hasUnsavedChanges: async () => true };
    const b = { saveAll: jasmine.createSpy('saveB').and.resolveTo({ ok: true }), hasUnsavedChanges: async () => false };
    persistence.registerPersistenceBridge('/work/device-a', a);
    persistence.registerPersistenceBridge('/work/device-b', b);
    const pendingA = persistence.saveAll('/work/device-a');
    expect(await persistence.saveAll('/work/device-b')).toEqual({ ok: true });
    expect(a.saveAll).toHaveBeenCalledTimes(1); expect(b.saveAll).toHaveBeenCalledTimes(1);
    expect(await (persistence as any).hasUnsavedChanges()).toBeTrue();
    finishA({ ok: true }); await pendingA;
  });
});

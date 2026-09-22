import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { CodeEditorProComponent } from './code-editor-pro.component';
import { CodeEditorFrameComponent } from './code-editor-frame.component';
import { CodeEditorProProjectService } from './services/code-editor-pro-project.service';

describe('Coder retained project workspaces', () => {
  let service: any;
  let originals: any;
  beforeEach(() => {
    originals = {
      path: window['path'],
      fs: window['fs'],
      platform: window['platform'],
      projectLock: window['projectLock'],
      ipcRenderer: window['ipcRenderer'],
    };
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
      coderWorkspaceSubject: new BehaviorSubject(null),
      boardConfigUpdatedSubject: new Subject(),
      configService: {
        data: { recentlyProjects: [] },
        save: jasmine.createSpy('save'),
        getApplicationName: () => 'Coder',
        getPreferredChatAgentRuntimeMode: () => 'coder',
      },
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
    expect(service.coderWorkspace.root).toBe('/work/device-a');
    expect(service.coderWorkspace.projects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
  });

  it('keeps delayed member iframe recent writes collapsed into the workspace entry', async () => {
    await service.addCoderProject('/work/device-b');
    const workspaceId = service.coderWorkspace.id;

    service.addRecentlyProject({ name: 'device-b', path: '/work/device-b' });
    service.addRecentlyProject({ name: 'device-a', path: '/work/device-a' });

    expect(service.configService.data.recentlyProjects.length).toBe(1);
    expect(service.configService.data.recentlyProjects[0]).toEqual(jasmine.objectContaining({
      path: '/work/device-a',
      coderWorkspaceId: workspaceId,
    }));
    expect(service.configService.data.recentlyProjects[0].coderProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
  });

  it('repairs previously raced independent recents when the guide list is read', async () => {
    await service.addCoderProject('/work/device-b');
    const workspaceId = service.coderWorkspace.id;
    service.configService.data.recentlyProjects = [
      { name: 'device-b', path: '/work/device-b' },
      { name: 'device-a', path: '/work/device-a' },
      { name: 'device-z', path: '/work/device-z' },
    ];

    const visible = service.recentlyProjects;

    expect(visible.map((project: any) => project.path)).toEqual(['/work/device-a', '/work/device-z']);
    expect(visible[0].coderWorkspaceId).toBe(workspaceId);
    expect(service.configService.data.recentlyProjects).toEqual(visible);
  });

  it('dissolves a two-project workspace into independent recents when one tab is closed', async () => {
    await service.addCoderProject('/work/device-b');
    await service.removeCoderProject('/work/device-b');
    expect(service.coderProjects.map((project: any) => project.path)).toEqual(['/work/device-a']);
    expect(service.coderWorkspace).toBeNull();
    expect(service.configService.data.coderWorkspaceGroups).toEqual([]);
    expect(service.configService.data.recentlyProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
    expect(service.configService.data.recentlyProjects.every((project: any) => !project.coderWorkspaceId)).toBeTrue();
  });

  it('unmerges a recent workspace without closing its open tabs', async () => {
    await service.addCoderProject('/work/device-b');
    const workspaceId = service.coderWorkspace.id;
    expect(service.unmergeCoderWorkspace({ workspaceId })).toBeTrue();
    expect(service.coderProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
    expect(service.coderWorkspace).toBeNull();
    expect(service.configService.data.recentlyProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
  });

  it('shrinks a three-project workspace and keeps the closed project independent', async () => {
    await service.addCoderProject('/work/device-b');
    await service.addCoderProject('/work/device-c');
    await service.removeCoderProject('/work/device-c');
    expect(service.coderWorkspace.projects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
    expect(service.configService.data.recentlyProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-c'
    ]);
    expect(service.configService.data.recentlyProjects[0].coderProjects.length).toBe(2);
    expect(service.configService.data.recentlyProjects[1].coderWorkspaceId).toBeUndefined();
  });

  it('promotes a remaining project when the workspace anchor tab is closed', async () => {
    await service.addCoderProject('/work/device-b');
    await service.addCoderProject('/work/device-c');
    const workspaceId = service.coderWorkspace.id;
    service.currentProjectPath = '/work/device-b';
    await service.removeCoderProject('/work/device-a');
    expect(service.coderWorkspace.id).toBe(workspaceId);
    expect(service.coderWorkspace.root).toBe('/work/device-b');
    expect(service.coderWorkspace.projects.map((project: any) => project.path)).toEqual([
      '/work/device-b', '/work/device-c'
    ]);
    expect(service.configService.data.recentlyProjects.map((project: any) => project.path)).toEqual([
      '/work/device-b', '/work/device-a'
    ]);
  });

  it('restores the associated project tabs when any workspace member is reopened', async () => {
    await service.addCoderProject('/work/device-b');
    service.coderProjectsSubject.next([]);
    service.currentProjectPathSubject.next('');
    service.registerCoderProject('/work/device-a');
    await service.restoreCoderWorkspaceTabs('/work/device-a');
    expect(service.coderProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b'
    ]);
  });

  it('keeps the independent current project as root when merging another saved group', async () => {
    service.configService.data.coderWorkspaceGroups = [{
      id: 'coder-workspace:old-b',
      root: '/work/device-b',
      name: 'old-b',
      activeProject: '/work/device-b',
      projects: [
        { path: '/work/device-b', name: 'device-b' },
        { path: '/work/device-c', name: 'device-c' },
      ],
    }];
    await service.addCoderProject('/work/device-b');
    expect(service.coderWorkspace.root).toBe('/work/device-a');
    expect(service.coderWorkspace.projects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b', '/work/device-c'
    ]);
    expect(service.coderProjects.map((project: any) => project.path)).toEqual([
      '/work/device-a', '/work/device-b', '/work/device-c'
    ]);
  });

  it('creates stable project contexts whose path and metadata do not change on tab activation', () => {
    const a = service.getCoderProjectContext('/work/device-a');
    const b = service.getCoderProjectContext('/work/device-b');
    b.currentPackageData = { name: 'B' };
    service.currentProjectPath = '/work/device-b';
    expect(service.coderWorkspace.root).toBe('/work/device-a');
    expect(service.coderWorkspace.activeProject).toBe('/work/device-b');
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

  it('coalesces a Windows atomic rename into one settled file refresh', () => {
    jasmine.clock().install();
    try {
      window['platform'] = { isWindows: true };
      const component: any = Object.create(CodeEditorFrameComponent.prototype);
      component.coderEmbedFsWatchers = new Map([[7, () => {}]]);
      component.coderEmbedFsWatchSettleTimers = new Map();
      component.pushCoderNativeFsWatchEvent = jasmine.createSpy('pushWatchEvent');

      const rename = { eventType: 'rename', filename: 'sketch\\src\\main.cpp' };
      component.scheduleSettledCoderNativeFsWatchEvent(7, rename);
      component.scheduleSettledCoderNativeFsWatchEvent(7, rename);
      jasmine.clock().tick(79);
      expect(component.pushCoderNativeFsWatchEvent).not.toHaveBeenCalled();
      jasmine.clock().tick(1);
      expect(component.pushCoderNativeFsWatchEvent).toHaveBeenCalledOnceWith(7, {
        eventType: 'change',
        filename: 'sketch\\src\\main.cpp',
      });
    } finally {
      jasmine.clock().uninstall();
    }
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

  it('projects independent build and upload progress into their matching project tabs', () => {
    const component: any = Object.create(CodeEditorProComponent.prototype);
    component.projectService = service;
    component.runtime = {
      getState: (path: string) => ({
        build: 'doing',
        upload: 'doing',
        notice: { progress: path.endsWith('a') ? 24.6 : 78.2 },
      }),
    };
    service.beginCoderOperation('build', '/work/device-a');
    service.beginCoderOperation('upload', '/work/device-b');

    expect(component.coderTabProgress('/work/device-a')).toBe(25);
    expect(component.coderTabProgress('/work/device-b')).toBe(78);
    expect(component.coderTabProgress('/work/device-c')).toBeNull();
  });

  it('allows switching during a background operation without saving or unloading its editor', async () => {
    service.beginCoderOperation('upload', '/work/device-a');
    service.ensureProjectModeAllowed = async () => true;
    service.configService.getApplicationName = () => 'Coder';
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
    const updateCodeHash = jasmine.createSpy('updateCodeHash').and.resolveTo('hash');
    const persistence = new CodeEditorProProjectService(
      {} as any,
      service,
      { updateCodeHash } as any,
    );
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
    expect(updateCodeHash).toHaveBeenCalledWith('/work/device-a');
    expect(updateCodeHash).toHaveBeenCalledWith('/work/device-b');
  });

  it('awaits code-hash persistence before acknowledging project-save', async () => {
    const listeners = new Map<string, (action: any) => any>();
    let finishHash!: (value: string) => void;
    const hashSaved = new Promise<string>(resolve => finishHash = resolve);
    const project = {
      currentProjectPath: '/work/device-a',
      isAilyCodeProject: () => true,
      copyPackageJsonToTemp: jasmine.createSpy('copyPackageJsonToTemp').and.resolveTo(true),
    };
    const persistence = new CodeEditorProProjectService(
      {
        listen: (type: string, callback: (action: any) => any) => listeners.set(type, callback),
      } as any,
      project as any,
      { updateCodeHash: () => hashSaved } as any,
    );
    persistence.registerPersistenceBridge('/work/device-a', {
      saveAll: async () => ({ ok: true }),
      hasUnsavedChanges: async () => false,
    });
    persistence.init();

    let acknowledged = false;
    const save = listeners.get('project-save')!({ payload: { path: '/work/device-a' } })
      .then((result: any) => {
        acknowledged = true;
        return result;
      });
    await Promise.resolve();
    expect(acknowledged).toBeFalse();

    finishHash('hash');
    expect(await save).toEqual({ success: true, path: '/work/device-a' });
    expect(project.copyPackageJsonToTemp).toHaveBeenCalledOnceWith('/work/device-a');
  });
});

import { BehaviorSubject, Subject, of } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { ProjectSaveMessageService } from '@core/app-shell/public-api';
import { MainWindowComponent } from '../../main-window/main-window.component';
import { HeaderComponent } from '../../main-window/components/header/header.component';
import { CodeEditorProComponent } from './code-editor-pro.component';
import { CodeEditorFrameComponent } from './code-editor-frame.component';
import { CodeEditorProProjectService } from './services/code-editor-pro-project.service';

describe('Coder iframe project-save command', () => {
  function fixture(active = true) {
    const view: any = Object.create(CodeEditorFrameComponent.prototype);
    const project = '/work/shortcut-project', frame = {};

    const bridge = { saveAll: jasmine.createSpy('save buffers').and.resolveTo({ ok: true }),
      hasUnsavedChanges: async () => false };

    const files = { saveLibraryChanges: jasmine.createSpy('save libraries').and.resolveTo(), isAilyCodeProject: () => true };
    const build = { updateCodeHash: jasmine.createSpy('update code hash').and.resolveTo('hash') };
    const persistence = new CodeEditorProProjectService({} as any, files as any, build as any);

    persistence.registerPersistenceBridge(project, bridge);

    let id = 0;

    const notice = { loading: jasmine.createSpy('loading').and.callFake(() => ({ messageId: 'save-' + ++id })),
      success: jasmine.createSpy('success').and.callFake(() => ({ messageId: 'saved-' + ++id, onClose: new Subject() })),
      remove: jasmine.createSpy('remove'), error: jasmine.createSpy('error') };
    Object.assign(view, { projectPath: project, coderEmbedWorkspaceRoot: project, coderFrameProjectPath: project,
      active, coderEmbedFrameReady: true, coderEmbedFrame: { nativeElement: { contentWindow: frame } },
      projectSaveMessages: new ProjectSaveMessageService(notice as any, { instant: (key: string) => key } as any),
      proProject: persistence, message: notice, translate: { instant: (key: string) => key },
      electronService: { isElectron: true }, simulatorSourceBridge: { receive: () => false } });

    const send = (source: unknown = frame) => view.onCoderNativeFsMessage({
      source, data: { channel: 'aily-coder-editor-project-save', projectPath: '/untrusted' },
    });

    return { view, project, bridge, files, build, notice, send };
  }

  it('immediately shows the active shortcut and waits for buffers, libraries and the code hash before showing completion', async () => {
    const h = fixture();
    let finish!: () => void;

    h.build.updateCodeHash.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));

    const saving = h.send();

    expect(h.notice.loading).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVING', { nzDuration: 0 });
    await Promise.resolve(); await Promise.resolve();
    expect(h.bridge.saveAll).toHaveBeenCalledTimes(1);
    expect(h.files.saveLibraryChanges).toHaveBeenCalledOnceWith(h.project);
    expect(h.build.updateCodeHash).toHaveBeenCalledOnceWith(h.project);
    expect(h.notice.success).not.toHaveBeenCalled();
    finish(); await saving;
    expect(h.notice.remove).toHaveBeenCalledOnceWith('save-1');
    expect(h.notice.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVED', { nzDuration: 4000, nzAnimate: false });
  });

  it('accepts the explicit save command posted by the mounted browser iframe', async () => {
    const h = fixture(), frame = document.createElement('iframe');

    frame.hidden = true;
    h.view.coderEmbedFrame = { nativeElement: frame };

    const received = new Promise<void>((resolve, reject) => {
      const listen = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.channel !== 'aily-coder-editor-project-save') return;

        window.removeEventListener('message', listen);
        h.view.onCoderNativeFsMessage(event).then(resolve, reject);
      };

      window.addEventListener('message', listen);
    });

    frame.srcdoc = '<script>parent.postMessage({channel:"aily-coder-editor-project-save"}, "*")</script>';

    document.body.appendChild(frame);

    try {
      await received;

      expect(h.bridge.saveAll).toHaveBeenCalledTimes(1);
      expect(h.notice.loading).toHaveBeenCalledTimes(1);
      expect(h.notice.success).toHaveBeenCalledTimes(1);
    } finally { frame.remove(); }
  });

  it('keeps inactive frames quiet and reports original save errors without a success message', async () => {
    for (const active of [true, false]) {
      const h = fixture(active);

      if (!active) {
        await h.send(); expect(h.bridge.saveAll).toHaveBeenCalledTimes(1);
        expect(h.notice.success).not.toHaveBeenCalled();
      }

      h.bridge.saveAll.and.resolveTo({ ok: false, message: 'disk full' });

      await h.send();
      expect(h.notice.loading.calls.count()).toBe(active ? 1 : 0);
      expect(h.notice.error).toHaveBeenCalledOnceWith('disk full');
      expect(h.notice.success).not.toHaveBeenCalled();
    }
  });

  it('ignores foreign, detached, unready and stale workspaces', async () => {
    const h = fixture();

    await h.send({}); await h.send(null);

    h.view.coderEmbedFrameReady = false; await h.send();
    h.view.coderEmbedFrameReady = true;
    h.view.coderFrameProjectPath = '/old'; await h.send();
    h.view.coderFrameProjectPath = h.project;
    h.view.coderEmbedWorkspaceRoot = '/other'; await h.send();
    h.view.coderEmbedWorkspaceRoot = h.project;
    h.view.dependencySession = {}; h.view.projectService = { assertProjectDependencySession: () => { throw Error('stale'); } };

    await h.send();

    h.view.dependencySession = undefined; h.view.destroyed = true; await h.send();

    expect(h.bridge.saveAll).not.toHaveBeenCalled();
    expect(h.notice.loading).not.toHaveBeenCalled();
  });

  it('discards feedback from a superseded command or a frame hidden before its save settles', async () => {
    const h = fixture();
    let finishFirst!: () => void, failSecond!: (e: Error) => void;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const second = new Promise<void>((_resolve, reject) => { failSecond = reject; });

    h.bridge.saveAll.and.returnValues(first.then(() => ({ ok: true })), second);

    const a = h.send(), b = h.send();

    expect(h.notice.remove.calls.allArgs()).toEqual([['save-1']]);
    finishFirst(); await a;
    expect(h.notice.success).not.toHaveBeenCalled();

    h.view.active = false; h.view.ngOnChanges({ active: {} });

    expect(h.notice.remove.calls.allArgs()).toEqual([['save-1'], ['save-2']]);
    failSecond(new Error('old project')); await b;
    expect(h.notice.error).not.toHaveBeenCalled();
    expect(h.notice.success).not.toHaveBeenCalled();
  });

  it('ignores an old background result after a replacement document loads in the same window', async () => {
    const h = fixture(false);
    let fail!: (e: Error) => void;

    h.bridge.saveAll.and.returnValue(new Promise((_resolve, reject) => { fail = reject; }));

    const saving = h.send();

    Object.assign(h.view, { coderLayout: { reset() {} }, codeSuggestionHostBridge: { registerFrame() {} },
      postCoderEditorUpdateState() {}, pushAilyCoderHostContext() {}, requestCoderEmbedLayoutRefresh() {} });

    h.view.onCoderEmbedFrameLoad();
    fail(new Error('old document')); await saving;
    expect(h.notice.loading).not.toHaveBeenCalled();
    expect(h.notice.error).not.toHaveBeenCalled();
    expect(h.notice.success).not.toHaveBeenCalled();
  });

  it('shows only the latest save when the File menu and iframe shortcut overlap in either order', async () => {
    for (const menuFirst of [true, false]) {
      const h = fixture();

      function gate() {
        let begin!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { begin = resolve; });
        const completed = new Promise<void>(resolve => { finish = resolve; });

        return { started, begin, completed, finish };
      }

      const menuGate = gate(), frameGate = gate();

      h.bridge.saveAll.and.callFake(async () => { frameGate.begin(); await frameGate.completed; return { ok: true }; });

      const path = new BehaviorSubject(h.project);

      const project: any = Object.assign(Object.create(ProjectService.prototype), { currentProjectPathSubject: path,
        currentProjectPath$: path.asObservable(), stateSubject: new BehaviorSubject('default'),
        getProjectMode: () => 'coder', prepareResolvedLibraryChangesForSave: async () => false, getPackageJson: async () => ({}) });

      const dispatch = jasmine.createSpy('menu save').and.callFake(async () => {
        menuGate.begin(); await menuGate.completed; return { success: true };
      });

      Object.defineProperties(project, {
        dependencyLifecycle: { value: { get: () => undefined } }, application: { value: { dispatchProjectSave: dispatch } },
        projectSaveReceipts: { value: { execute: async (_p: string, _r: unknown, _c: unknown, save: () => Promise<unknown>) => ({ result: await save() }) } },
      });

      const shell = Object.assign(Object.create(MainWindowComponent.prototype), { projectService: project,
        uiService: { actionSubject: new Subject() }, cd: { detectChanges() {} }, projectSaveMessages: h.view.projectSaveMessages,
        message: h.notice, translate: h.view.translate, workspaceHostProviders: { stop: async () => {} } });

      const header = Object.assign(Object.create(HeaderComponent.prototype), { projectService: project,
        configService: { isCoderProduct: () => true }, dependencyBlockMessage: () => undefined });

      shell.ngAfterViewInit();

      const menu = () => header.process({ action: 'project-save' }, null, 'manual');
      const unrelated = h.view.projectSaveMessages.saving('/other-project');
      const first = menuFirst ? menu() : h.send();

      await (menuFirst ? menuGate : frameGate).started;

      const second = menuFirst ? h.send() : menu();

      await (menuFirst ? frameGate : menuGate).started;
      expect(h.notice.remove.calls.allArgs()).toEqual([['save-2']]);

      if (menuFirst) {
        menuGate.finish(); await first;
        expect(h.notice.success).not.toHaveBeenCalled();
        frameGate.finish(); await second;
      } else {
        menuGate.finish(); await second;
        expect(h.notice.success).toHaveBeenCalledTimes(1);
        frameGate.finish(); await first;
      }

      expect(h.notice.remove.calls.allArgs()).toEqual([['save-2'], ['save-3']]);
      expect(h.notice.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVED', { nzDuration: 4000, nzAnimate: false });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(h.bridge.saveAll).toHaveBeenCalledTimes(1);
      h.view.projectSaveMessages.clear(unrelated);
      shell.ngOnDestroy();
    }
  });
});

describe('Coder title cached library state', () => {
  it('uses cached libraries for title polling while preserving authoritative close checks', async () => {
    const project: any = {hasCachedLibraryChanges:jasmine.createSpy('cached').and.returnValue(false),
      hasUnsavedLibraryChanges:jasmine.createSpy('authoritative').and.resolveTo(false)};

    const service = new CodeEditorProProjectService({} as any,project,{} as any);
    const bridge = {saveAll:async()=>({ok:true}),hasUnsavedChanges:jasmine.createSpy('editors').and.resolveTo(false)};

    service.registerPersistenceBridge('/project',bridge);
    expect(await service.hasSavedProject('/project',true)).toBeTrue();
    expect(project.hasUnsavedLibraryChanges).not.toHaveBeenCalled();
    project.hasCachedLibraryChanges.and.returnValue(true);
    expect(await service.hasSavedProject('/project',true)).toBeFalse();
    expect(bridge.hasUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(await service.hasSavedProject('/project')).toBeTrue();
    expect(project.hasUnsavedLibraryChanges).toHaveBeenCalledOnceWith('/project');
  });
});

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

    window['fs'] = { isDirectory: () => true, existsSync: () => true };
    window['ipcRenderer'] = { send: jasmine.createSpy('send') };
    window['projectLock'] = { tryAcquire: jasmine.createSpy('acquire').and.resolveTo({ ok: true }), release: jasmine.createSpy('release').and.resolveTo() };
    service = Object.create(ProjectService.prototype);

    Object.assign(service, {
      coderOperationSubject: new BehaviorSubject(null), coderOperationsSubject: new BehaviorSubject(new Map()),
      projectNavigationIntentRevision: 0,
      projectOpeningChangedSubject: new Subject<void>(),
      coderOperations: new Map(), coderProjectContexts: new Map(), coderProjectsSubject: new BehaviorSubject([]),
      currentProjectPathSubject: new BehaviorSubject(''), stateSubject: new BehaviorSubject('loaded'),
      coderWorkspaceSubject: new BehaviorSubject(null),
      boardConfigUpdatedSubject: new Subject(),
      configService: {
        getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local',
        data: { recentlyProjects: [] },
        save: jasmine.createSpy('save'),
        getApplicationName: () => 'Coder',
        getPreferredChatAgentRuntimeMode: () => 'coder',
      },
      getProjectMode: (path: string) => path.includes('device') ? 'coder' : 'blockly',
      isAilyCodeProject: (path: string) => path.includes('device'),
      electronService: { isElectron: true, exists: () => true, readFile: () => '{"name":"device","type":"coder"}', setTitle: jasmine.createSpy('title') },
    });

    service.projectLifecycle = {hasActive: () => false, acquire: () => ({token: Symbol('fixture'), release() {}})};
    service.stopProjectCommands = jasmine.createSpy('stopProjectCommands').and.resolveTo();

    Object.defineProperty(service, 'application', {value: {hasActiveProjectMutation: () => false}, configurable: true});

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
    service.routerService = { navigate: jasmine.createSpy('navigate').and.resolveTo(true), createUrlTree: () => ({}), isActive: () => false };
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
    component.persistence = { hasSavedProject: async () => false, saveAll: jasmine.createSpy('save').and.resolveTo() };
    component.modal = { create: () => ({ afterClose: of({ result: 'save' }) }) };
    component.message = { error: jasmine.createSpy('error') };

    await component.closeCoderProject('/work/device-b', new Event('click'));
    expect(component.persistence.saveAll).toHaveBeenCalledOnceWith('/work/device-b');
    expect(service.coderProjects.length).toBe(1);
    expect(service.currentProjectPath).toBe('/work/device-a');
  });

  it('discards only the closing tab and does not save another project', async () => {
    await service.addCoderProject('/work/device-b');

    const component: any = Object.create(CodeEditorProComponent.prototype);
    component.projectService = service;
    component.closing = new Set();
    component.persistence = { hasSavedProject: async () => false, saveAll: jasmine.createSpy('save') };
    component.modal = { create: () => ({ afterClose: of({ result: 'continue' }) }) };
    component.message = { error: jasmine.createSpy('error') };

    spyOn(service, 'discardLibraryChanges').and.resolveTo();
    await component.closeCoderProject('/work/device-b', new Event('click'));
    expect(service.discardLibraryChanges).toHaveBeenCalledOnceWith('/work/device-b');
    expect(component.persistence.saveAll).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe('/work/device-a');
    expect(service.coderProjects.length).toBe(1);
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
      saveLibraryChanges: jasmine.createSpy('saveLibraryChanges').and.resolveTo(),
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
  });
});

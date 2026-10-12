import { getChildToolConfigs, replaceChildToolConfigs, type ChildToolConfig } from '../../configs/tool.config';
import { BehaviorSubject, Subject } from 'rxjs';
import { SubappActivityService } from '@integration/subapps/public-api';
import { ChildToolHostComponent } from './child-tool-host.component';
import { ChildToolSurfaceHostComponent } from '../child-tool-surface-host/child-tool-surface-host.component';

describe('Subapp Dock surface contract', () => {
  let previous: ChildToolConfig[];
  beforeEach(() => {
    previous = Object.values(getChildToolConfigs());
    replaceChildToolConfigs([
      { id: 'ffs-manager-child', titleKey: 'FFS', namespace: 'FFS', ui: { surfaces: { compact: { entry: 'ui/index.html' } } } },
      { id: 'window-only', titleKey: 'Window', namespace: 'Window', ui: { surfaces: { default: { entry: 'ui/index.html' } } } },
      { id: 'native-observer', titleKey: 'Native', namespace: 'Native', runtime: { headless: true, observer: true } },
    ]);
  });
  afterEach(() => replaceChildToolConfigs(previous));

  function host(toolId: string) {
    const component = Object.create(ChildToolHostComponent.prototype) as any;
    component.isAilyChatTool = () => true;
    component.ailyChatSessionId = 'session';
    component.subappActivityService = new SubappActivityService();
    component.subappActivityService.recordInvocationStarted({ sessionId: 'session', toolId, toolName: 'snapshot' });
    component.mainUiAutomation = { openChildApp: jasmine.createSpy('openChildApp').and.resolveTo({ ok: true }) };
    return component;
  }

  function compactHost() {
    const component = Object.create(ChildToolSurfaceHostComponent.prototype) as any;
    component.toolId = 'ffs-manager-child';
    component.surface = 'compact';
    component.placement = 'chat-dock';
    component.active = true;
    component.contextId = 'compact-context';
    component.contextVersion = 0;
    component.projectService = {
      currentProjectPath: '/published-before-provider-ready',
      currentProjectPath$: new BehaviorSubject('/published-before-provider-ready'),
    };
    component.workspaceHostProviders = {
      readReadyWorkspace: jasmine.createSpy('readReadyWorkspace').and.returnValue(null),
      readyWorkspaceChanges$: new BehaviorSubject<void>(undefined),
    };
    component.translate = { currentLang: 'en', onLangChange: new Subject<void>() };
    component.themeService = { theme: () => 'dark', themeChanged$: new Subject<void>() };
    component.remoteApi = {
      setHostContext: jasmine.createSpy('setHostContext').and.resolveTo({ ok: true }),
      refreshHostSnapshot: jasmine.createSpy('refreshHostSnapshot').and.resolveTo({ ok: true }),
    };
    return component;
  }

  it('uses the Main registered-tool readiness projection instead of the already published project path', async () => {
    const component = compactHost();
    component.bindTool = jasmine.createSpy('bindTool');
    component.ngOnInit();
    expect(component.workspaceHostProviders.readReadyWorkspace).toHaveBeenCalledWith('ffs-manager-child');
    expect(component.remoteApi.setHostContext.calls.mostRecent().args[0].workspace).toBeNull();

    component.workspaceHostProviders.readReadyWorkspace.and.returnValue('/ready-blank');
    component.workspaceHostProviders.readyWorkspaceChanges$.next();
    expect(component.remoteApi.setHostContext.calls.mostRecent().args[0].workspace).toBe('/ready-blank');
    await Promise.resolve();
    expect(component.remoteApi.refreshHostSnapshot).toHaveBeenCalled();

    const pushed = component.remoteApi.setHostContext;
    const beforeDestroy = pushed.calls.count();
    component.ngOnDestroy();
    component.projectService.currentProjectPath$.next('/late-project');
    component.workspaceHostProviders.readyWorkspaceChanges$.next();
    expect(pushed.calls.count()).toBe(beforeDestroy);
  });

  it('preserves the service passthrough workspace for an unregistered compact tool', () => {
    const component = compactHost();
    component.toolId = 'plain-tool';
    component.workspaceHostProviders.readReadyWorkspace.and.returnValue('/ordinary-project');
    expect(component.createHostContext().workspace).toBe('/ordinary-project');
    expect(component.workspaceHostProviders.readReadyWorkspace).toHaveBeenCalledOnceWith('plain-tool');
  });

  for (const workspace of [null, '/main-ready-blank']) {
    it(`preserves the detached Main workspace input ${workspace === null ? 'null' : 'value'} in both snapshot and pushed context`, async () => {
      const component = compactHost();
      component.hostWorkspace = workspace;
      component.initialized = true;
      component.active = false;
      const snapshot = component.createHostContext();
      component.ngOnChanges({ hostWorkspace: { currentValue: workspace } });
      const pushed = component.remoteApi.setHostContext.calls.mostRecent().args[0];

      expect(snapshot.workspace).toBe(workspace);
      expect(pushed.workspace).toBe(workspace);
      expect(component.workspaceHostProviders.readReadyWorkspace).not.toHaveBeenCalled();
      expect(Object.keys(snapshot).sort()).toEqual([
        'capabilities', 'contextId', 'density', 'embedded', 'interactive', 'lang', 'placement',
        'platform', 'surface', 'theme', 'toolId', 'version', 'workspace',
      ].sort());
      expect(Object.keys(pushed).sort()).toEqual(Object.keys(snapshot).sort());
      expect(pushed).toEqual({ ...snapshot, version: String(Number(snapshot.version) + 1) });
      expect(snapshot.contextId).toBe('compact-context');
      expect(snapshot.embedded).toBeTrue();
      expect(snapshot.surface).toBe('compact');
      expect(snapshot.placement).toBe('chat-dock');
      expect(snapshot.density).toBe('compact');
      expect(snapshot.capabilities.runtimeControl).toBeFalse();
      await Promise.resolve();
      expect(component.remoteApi.refreshHostSnapshot).toHaveBeenCalledOnceWith();
    });
  }

  it('returns to the Main readiness projection only when the detached input is undefined', () => {
    const component = compactHost();
    component.hostWorkspace = null;
    expect(component.createHostContext().workspace).toBeNull();
    component.hostWorkspace = undefined;
    component.workspaceHostProviders.readReadyWorkspace.and.returnValue('/main-ready-again');
    expect(component.createHostContext().workspace).toBe('/main-ready-again');
    expect(component.workspaceHostProviders.readReadyWorkspace).toHaveBeenCalledOnceWith('ffs-manager-child');
  });

  it('passes only the outer detached Main projection to compact surfaces', () => {
    const component = host('ffs-manager-child');
    component.currentUrl = '/main/blockly-editor';
    expect(component.surfaceHostWorkspace).toBeUndefined();
    component.currentUrl = '/child-tool/aily-chat';
    expect(component.surfaceHostWorkspace).toBeNull();
    component.standaloneWorkspace = null;
    expect(component.surfaceHostWorkspace).toBeNull();
    component.standaloneWorkspace = '/detached-main-ready';
    expect(component.surfaceHostWorkspace).toBe('/detached-main-ready');
  });

  for (const toolId of ['ffs-manager-child', 'native-observer']) {
    it(`expands ${toolId} without opening another window`, async () => {
      const component = host(toolId);
      expect(await component.setSubappSurfaceState({ sessionId: 'session', toolId, surfaceState: 'expanded' }))
        .toEqual(jasmine.objectContaining({ ok: true, surfaceState: 'expanded' }));
      expect(component.mainUiAutomation.openChildApp).not.toHaveBeenCalled();
    });
  }

  it('opens the full app when the requested Dock surface is not declared', async () => {
    const component = host('window-only');
    const result = await component.setSubappSurfaceState({ sessionId: 'session', toolId: 'window-only', surfaceState: 'expanded' });
    expect(result).toEqual(jasmine.objectContaining({ ok: true, surfaceState: 'collapsed' }));
    expect(component.mainUiAutomation.openChildApp).toHaveBeenCalledOnceWith({ toolId: 'window-only', mode: 'embedded' });
    expect(component.subappActivityService.getActivity('session', 'window-only').surfaceState).toBe('collapsed');
  });

  it('preserves opening failures and rejects a different session before opening UI', async () => {
    const component = host('window-only');
    component.mainUiAutomation.openChildApp.and.resolveTo({ ok: false, message: 'Unavailable' });
    expect((await component.setSubappSurfaceState({ sessionId: 'other', toolId: 'window-only', surfaceState: 'expanded' })).ok).toBeFalse();
    expect(component.mainUiAutomation.openChildApp).not.toHaveBeenCalled();
    expect(await component.setSubappSurfaceState({ sessionId: 'session', toolId: 'window-only', surfaceState: 'expanded' }))
      .toEqual({ ok: false, message: 'Unavailable' });
    expect(component.subappActivityService.getActivity('session', 'window-only').surfaceState).toBe('collapsed');
  });

  it('collapses an obsolete surface without opening a full app', async () => {
    const component = host('window-only');
    component.subappActivityService.setSurfaceState('session', 'window-only', 'expanded');
    expect((await component.setSubappSurfaceState({ sessionId: 'session', toolId: 'window-only', surfaceState: 'collapsed' })).ok).toBeTrue();
    expect(component.mainUiAutomation.openChildApp).not.toHaveBeenCalled();
  });

  it('forwards partition operations through the shared host authority only for the partition manager', async () => {
    const component = Object.create(ChildToolSurfaceHostComponent.prototype) as any;
    component.toolId = 'ffs-manager-child';
    component.ngZone = { run: (action: () => unknown) => action() };
    component.uiService = { partitionManagerRequest: jasmine.createSpy('partitionManagerRequest').and.resolveTo({ success: true }) };
    for (const action of ['partition-manager-load', 'partition-manager-save', 'partition-manager-ports', 'partition-manager-read-device']) {
      const request = { action, projectPath: '/fixture' };
      expect(await component.partitionManagerRequest(request)).toEqual({ success: true });
      expect(component.uiService.partitionManagerRequest).toHaveBeenCalledWith(request);
    }
    component.toolId = 'another-tool';
    expect((await component.partitionManagerRequest({ action: 'partition-manager-save' })).success).toBeFalse();
    expect(component.uiService.partitionManagerRequest).toHaveBeenCalledTimes(4);
  });
});

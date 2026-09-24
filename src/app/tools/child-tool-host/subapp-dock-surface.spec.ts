import { getChildToolConfigs, replaceChildToolConfigs, type ChildToolConfig } from '../../configs/tool.config';
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

import { Subject } from 'rxjs';
import { getChildToolConfigs, replaceChildToolConfigs, type ChildToolConfig } from '../../../configs/tool.config';
import { UiService } from '../../core/app-shell/ui.service';
import { MainUiAutomationService } from '../automation/main-ui-automation.service';
import { ChildToolHostComponent } from '../../../tools/child-tool-host/child-tool-host.component';
import { SubappAgentBridgeService } from './subapp-agent-bridge.service';

describe('Extension service UI boundary', () => {
  let previousConfigs: ChildToolConfig[];
  const extensionIds = ['aily-coder-editor', 'another-extension'];
  const config = (id: string, extension?: boolean): ChildToolConfig => ({
    id, titleKey: id, namespace: id, app: { extension },
  });

  beforeEach(() => {
    previousConfigs = Object.values(getChildToolConfigs());
    replaceChildToolConfigs([
      ...extensionIds.map(id => config(id, true)),
      config('ordinary-app', false), config('legacy-app'),
    ]);
  });

  afterEach(() => replaceChildToolConfigs(previousConfigs));

  function automation() {
    const ui: any = {
      openToolList: [], topTool: null,
      openToolWindow: jasmine.createSpy('openToolWindow').and.returnValue(true),
      openToolEmbedded: jasmine.createSpy('openToolEmbedded').and.callFake((id: string) => {
        ui.topTool = id;
        return true;
      }),
    };
    const registry = {
      ensureInitialized: () => {},
      control: jasmine.createSpy('control').and.resolveTo({ ok: true }),
      getStatus: () => null,
    };
    const service = new MainUiAutomationService({} as any, registry as any, ui, {
      instant: (key: string) => key,
    } as any) as any;
    service.readWindowState = jasmine.createSpy('readWindowState').and.resolveTo({ open: false });
    service.readChildToolSessions = jasmine.createSpy('readChildToolSessions').and.resolveTo([
      { toolId: 'aily-coder-editor', running: true, pid: 123, refCount: 1 },
    ]);
    return { service, ui, registry };
  }

  for (const toolId of extensionIds) {
    for (const mode of ['embedded', 'window']) {
      it(`rejects ${mode} opening of ${toolId} before touching any UI`, async () => {
        const { service, ui, registry } = automation();
        const result = await service.openChildApp({ toolId, mode });
        expect(result).toEqual(jasmine.objectContaining({
          ok: false, extension: true, errorCode: 'SUBAPP_EXTENSION_UI_UNAVAILABLE',
        }));
        expect(service.readWindowState).not.toHaveBeenCalled();
        expect(ui.openToolWindow).not.toHaveBeenCalled();
        expect(ui.openToolEmbedded).not.toHaveBeenCalled();
        expect(registry.control).not.toHaveBeenCalled();
      });
    }
  }

  it('does not advertise UI actions while retaining extension runtime discovery', async () => {
    const { service } = automation();
    const { app } = await service.getChildApp({ toolId: 'aily-coder-editor' });
    expect(app.extension).toBeTrue();
    expect(app.supportedActions).toEqual([]);
    expect(app.mode).toBe('background');
    expect(app.runtime).toEqual(jasmine.objectContaining({ running: true, pid: 123, refCount: 1 }));
    const { items } = await service.listChildApps();
    expect(items.find((item: any) => item.id === 'another-extension').extension).toBeTrue();
    expect(items.find((item: any) => item.id === 'ordinary-app').supportedActions).toContain('open_window');
  });

  for (const applicationName of ['aily blockly', 'aily coder']) {
    it(`filters the shared @ and + candidate list by extension and only in ${applicationName}`, async () => {
      const host = Object.create(ChildToolHostComponent.prototype) as any;
      host.isAilyChatTool = () => true;
      host.configService = { getApplicationName: () => applicationName };
      host.subappManager = {
        state: {
          apps: [
            { toolId: 'aily-coder-editor', only: 'aily coder', extension: true },
            { toolId: 'another-extension', only: 'all', extension: true },
            { toolId: 'coder-only', only: ' AILY CODER ' },
            { toolId: 'blockly-only', only: 'aily blockly' },
            { toolId: 'all-app', only: 'all' },
            { toolId: 'legacy-app' },
          ],
        },
      };
      host.mainUiAutomation = {
        listChildApps: jasmine.createSpy('listChildApps').and.resolveTo({
          ok: true,
          items: [
            { id: 'aily-coder-editor', extension: true },
            { id: 'another-extension', extension: true },
            { id: 'coder-only', extension: false },
            { id: 'blockly-only', extension: false },
            { id: 'all-app', extension: false },
            { id: 'legacy-app', extension: false },
          ],
        }),
      };
      const result = await host.listChatChildApps({ limit: 100 });
      expect((result.items as Array<{ id: string }>).map(item => item.id)).toEqual(
        applicationName === 'aily blockly'
          ? ['blockly-only', 'all-app', 'legacy-app']
          : ['coder-only', 'all-app', 'legacy-app'],
      );
    });
  }

  it('rejects detach/embed even for a stale extension host', async () => {
    const { service, ui, registry } = automation();
    ui.openToolList = ['aily-coder-editor'];
    service.readWindowState.and.resolveTo({ open: true });
    for (const action of ['detach', 'embed', 'focus', 'restart']) {
      expect((await service.controlChildApp({ toolId: 'aily-coder-editor', action })).ok).toBeFalse();
    }
    expect(registry.control).not.toHaveBeenCalled();
    expect(service.readWindowState).not.toHaveBeenCalled();
  });

  for (const toolId of ['ordinary-app', 'legacy-app']) {
    it(`preserves embedded and window opening for ${toolId}`, async () => {
      const { service, ui } = automation();
      expect((await service.openChildApp({ toolId, mode: 'embedded' })).ok).toBeTrue();
      expect(ui.openToolEmbedded).toHaveBeenCalledOnceWith(toolId);
      expect((await service.openChildApp({ toolId, mode: 'window' })).ok).toBeTrue();
      expect(ui.openToolWindow).toHaveBeenCalledTimes(1);
    });
  }

  it('reports a refused standalone window as failure', async () => {
    const { service, ui } = automation();
    ui.openToolWindow.and.returnValue(false);
    expect((await service.openChildApp({ toolId: 'ordinary-app', mode: 'window' })).ok).toBeFalse();
  });

  it('blocks direct shell entry points without changing the embedded stack or window list', () => {
    const service = Object.create(UiService.prototype) as any;
    service.openToolList = ['ordinary-app'];
    service.openWindowPathList = [];
    service.actionSubject = new Subject();
    const events: unknown[] = [];
    service.actionSubject.subscribe((event: unknown) => events.push(event));
    service.requestLoginForProtectedTool = jasmine.createSpy('requestLogin').and.returnValue(false);
    for (const toolId of extensionIds) {
      service.openTool(toolId);
      service.turnTool({ type: 'tool', data: toolId });
      expect(service.openToolEmbedded(toolId)).toBeFalse();
      expect(service.openToolWindow(toolId)).toBeFalse();
      service.openWindow({ path: `child-tool/${toolId}` });
      service.openToolInMainWindow(toolId);
    }
    expect(service.openToolList).toEqual(['ordinary-app']);
    expect(service.openWindowPathList).toEqual([]);
    expect(events).toEqual([]);
    expect(service.requestLoginForProtectedTool).not.toHaveBeenCalled();
    expect(service.openToolEmbedded('legacy-app')).toBeTrue();
    expect(service.topTool).toBe('legacy-app');
  });

  it('rejects a direct child-tool route before acquiring the extension runtime', async () => {
    const host = Object.create(ChildToolHostComponent.prototype) as any;
    host.subappManager = { initialize: async () => {} };
    host.resolveToolId = () => 'aily-coder-editor';
    host.route = { snapshot: { paramMap: { get: () => 'aily-coder-editor' } } };
    host.router = { url: '/child-tool/aily-coder-editor' };
    host.log = () => {};
    host.showConfigError = jasmine.createSpy('showConfigError');
    host.startServer = jasmine.createSpy('startServer');
    host.registerHostController = jasmine.createSpy('registerHostController');
    await host.initTool();
    expect(host.showConfigError).toHaveBeenCalledWith(jasmine.stringMatching('扩展服务'));
    expect(host.startServer).not.toHaveBeenCalled();
    expect(host.registerHostController).not.toHaveBeenCalled();
  });

  for (const presentUi of [undefined, 'embedded', 'window']) {
    it(`keeps extension domain RPC available without UI when presentUi=${presentUi}`, async () => {
      const service = Object.create(SubappAgentBridgeService.prototype) as any;
      service.resolveAgentTool = () => ({
        config: config('aily-coder-editor', true),
        definition: { rpc: { method: 'extension.status' }, presentation: { mode: 'dock' } },
      });
      service.automation = {
        isChildAppWindowOpen: jasmine.createSpy('isChildAppWindowOpen').and.resolveTo(true),
        openChildApp: jasmine.createSpy('openChildApp'),
      };
      service.subappActivityService = {
        recordInvocationStarted: jasmine.createSpy('recordInvocationStarted'),
        recordInvocationCompleted: jasmine.createSpy('recordInvocationCompleted'),
      };
      service.request = jasmine.createSpy('request').and.resolveTo({ ready: true });
      const result = await service.execute({
        toolId: 'aily-coder-editor', tool: 'extension_status',
        params: presentUi === undefined ? {} : { presentUi },
      });
      expect(result.ok).toBeTrue();
      expect(service.request).toHaveBeenCalledTimes(1);
      expect(service.automation.isChildAppWindowOpen).not.toHaveBeenCalled();
      expect(service.automation.openChildApp).not.toHaveBeenCalled();
      expect(service.subappActivityService.recordInvocationStarted.calls.mostRecent().args[0].presentation)
        .toBeUndefined();
    });
  }
});

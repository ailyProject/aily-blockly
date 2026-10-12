import { EventEmitter } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ChildToolHostComponent } from './child-tool-host.component';

describe('Visible child-tool window handoff', () => {
  let originalIWindow: any;

  beforeEach(() => {
    originalIWindow = window['iWindow'];
  });

  afterEach(() => {
    window['iWindow'] = originalIWindow;
  });

  it('lets an observed ToolContainer open action own the handoff', () => {
    const component = Object.create(ToolContainerComponent.prototype) as any;
    component.openWindowEvent = new EventEmitter<void>();
    component.uiService = { openWindow: jasmine.createSpy('openWindow') };
    component.close = jasmine.createSpy('close');
    const requested = jasmine.createSpy('requested');
    component.openWindowEvent.subscribe(requested);

    component.openWindow();

    expect(requested).toHaveBeenCalledTimes(1);
    expect(component.uiService.openWindow).not.toHaveBeenCalled();
    expect(component.close).not.toHaveBeenCalled();
  });

  it('preserves the original ToolContainer open-and-close behavior without an observer', () => {
    const component = Object.create(ToolContainerComponent.prototype) as any;
    component.openWindowEvent = new EventEmitter<void>();
    component.path = 'legacy-tool';
    component.title = 'Legacy tool';
    component.uiService = { openWindow: jasmine.createSpy('openWindow') };
    component.close = jasmine.createSpy('close');

    component.openWindow();

    expect(component.uiService.openWindow).toHaveBeenCalledOnceWith({
      path: 'legacy-tool', title: 'Legacy tool', width: 1200, height: 800,
    });
    expect(component.close).toHaveBeenCalledTimes(1);
  });

  it('routes an observed SubWindow GoMain action without calling native GoMain twice', () => {
    const component = Object.create(SubWindowComponent.prototype) as any;
    component.goMainEvent = new EventEmitter<void>();
    component.currentUrl = '/child-tool/simulator';
    window['iWindow'] = { goMain: jasmine.createSpy('goMain') };
    const requested = jasmine.createSpy('requested');
    component.goMainEvent.subscribe(requested);

    component.goMain();

    expect(requested).toHaveBeenCalledTimes(1);
    expect(window['iWindow'].goMain).not.toHaveBeenCalled();
  });

  it('preserves native SubWindow GoMain without an observer', () => {
    const component = Object.create(SubWindowComponent.prototype) as any;
    component.goMainEvent = new EventEmitter<void>();
    component.currentUrl = '/child-tool/legacy-tool';
    window['iWindow'] = { goMain: jasmine.createSpy('goMain') };

    component.goMain();

    expect(window['iWindow'].goMain).toHaveBeenCalledOnceWith('/child-tool/legacy-tool');
  });

  it('uses the guarded host detach lifecycle and closes embedded state only after opening', async () => {
    const host = childHost('/main/');

    const result = await host.detach();

    expect(result).toEqual(jasmine.objectContaining({ ok: true, action: 'detach', mode: 'window' }));
    expect(host.notifyChildBeforeClose).toHaveBeenCalledOnceWith('close');
    expect(host.uiService.openToolWindow).toHaveBeenCalledOnceWith('simulator', {
      title: 'Simulator',
    });
    expect(host.uiService.completeToolClose).toHaveBeenCalledOnceWith('simulator');
  });

  it('does not close embedded state when the child or window opening rejects detach', async () => {
    const childRefused = childHost('/main/');
    childRefused.notifyChildBeforeClose.and.resolveTo(false);
    expect((await childRefused.detach()).ok).toBeFalse();
    expect(childRefused.uiService.openToolWindow).not.toHaveBeenCalled();
    expect(childRefused.uiService.completeToolClose).not.toHaveBeenCalled();

    const windowRefused = childHost('/main/');
    windowRefused.uiService.openToolWindow.and.returnValue(false);
    expect((await windowRefused.detach()).ok).toBeFalse();
    expect(windowRefused.uiService.completeToolClose).not.toHaveBeenCalled();
  });

  it('uses the guarded host embed lifecycle and does not bypass a child refusal', async () => {
    window['iWindow'] = { goMain: jasmine.createSpy('goMain') };
    const accepted = childHost('/child-tool/simulator');
    expect(await accepted.embed()).toEqual(jasmine.objectContaining({
      ok: true, action: 'embed', mode: 'embedded',
    }));
    expect(accepted.notifyChildBeforeClose).toHaveBeenCalledOnceWith('close');
    expect(window['iWindow'].goMain).toHaveBeenCalledOnceWith('/child-tool/simulator');

    const refused = childHost('/child-tool/simulator');
    refused.notifyChildBeforeClose.and.resolveTo(false);
    expect((await refused.embed()).ok).toBeFalse();
    expect(window['iWindow'].goMain).toHaveBeenCalledTimes(1);
  });
});

function childHost(currentUrl: string): any {
  const host = Object.create(ChildToolHostComponent.prototype) as any;
  host.config = {};
  host.currentUrl = currentUrl;
  host.resolvedToolId = 'simulator';
  host.routePath = '/child-tool/simulator';
  host.getToolDisplayName = () => 'Simulator';
  host.notifyChildBeforeClose = jasmine.createSpy('notifyChildBeforeClose').and.resolveTo(true);
  host.uiService = {
    openToolWindow: jasmine.createSpy('openToolWindow').and.returnValue(true),
    completeToolClose: jasmine.createSpy('completeToolClose'),
  };
  return host;
}

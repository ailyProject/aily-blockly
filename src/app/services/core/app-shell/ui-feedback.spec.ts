import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { UiService } from './ui.service';
import { ChildAppHostRegistryService } from '@integration/subapps/public-api';
import { ChildToolHostComponent } from '../../../tools/child-tool-host/child-tool-host.component';

describe('host feedback background chat report', () => {
  let ui: any;
  let registry: ChildAppHostRegistryService;
  let create: jasmine.Spy;
  let previousSubWindow: any;

  beforeEach(() => {
    registry = new ChildAppHostRegistryService();
    create = jasmine.createSpy('create').and.returnValue({ afterClose: new Subject() });
    ui = Object.create(UiService.prototype);
    ui.modalService = { create };
    ui.childHostRegistry = registry;
    previousSubWindow = window['subWindow'];
    window['subWindow'] = { command: jasmine.createSpy('command').and.resolveTo({ ok: false }) } as any;
  });

  afterEach(() => { window['subWindow'] = previousSubWindow; });

  it('opens the original dialog immediately while upload is pending and coexists with cancel', () => {
    const afterClose = new Subject();
    create.and.returnValue({ afterClose });
    const reportIssue = jasmine.createSpy().and.returnValue(new Promise(() => {}));
    registry.register('aily-chat', { reportIssue } as any);
    ui.openFeedback({ feedbackType: 'bug' });
    expect(create.calls.mostRecent().args[0].nzData).toEqual({ feedbackType: 'bug' });
    expect(reportIssue).toHaveBeenCalledTimes(1);
    expect(window['subWindow'].command).not.toHaveBeenCalled();
    afterClose.next({ result: 'cancel' });
    expect(reportIssue).toHaveBeenCalledTimes(1);
  });

  it('contains both synchronous controller errors and rejected reports without disrupting feedback', fakeAsync(() => {
    const reportIssue = jasmine.createSpy().and.throwError('unavailable');
    registry.register('aily-chat', { reportIssue } as any);
    expect(() => ui.openFeedback()).not.toThrow();
    flushMicrotasks();
    reportIssue.and.rejectWith(new Error('offline'));
    ui.openFeedback();
    flushMicrotasks();
    expect(create).toHaveBeenCalledTimes(2);
  }));

  it('uses the existing detached window command without opening or focusing a tool', fakeAsync(() => {
    ui.openTool = jasmine.createSpy('openTool');
    ui.openFeedback();
    flushMicrotasks();
    expect(window['subWindow'].command).toHaveBeenCalledWith('/child-tool/aily-chat', {
      toolId: 'aily-chat', action: 'reportIssue',
    });
    expect(ui.openTool).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  }));

  it('only forwards an existing active Chat session, tolerating older children and disconnection', async () => {
    const host: any = Object.create(ChildToolHostComponent.prototype);
    host.isAilyChatTool = () => true;
    host.ailyChatSessionId = '';
    const report = jasmine.createSpy().and.resolveTo({ ok: true });
    host.remoteApi = { reportSessionIssue: report };
    expect((await host.reportChatSessionIssue()).skipped).toBeTrue();
    host.ailyChatSessionId = 'original-session';
    expect((await host.reportChatSessionIssue()).ok).toBeTrue();
    expect(report).toHaveBeenCalledOnceWith({ sessionId: 'original-session' });
    host.remoteApi = {};
    expect((await host.reportChatSessionIssue()).skipped).toBeTrue();
    host.remoteApi = { reportSessionIssue: () => Promise.reject(new Error('disconnected')) };
    expect((await host.reportChatSessionIssue()).ok).toBeFalse();
    host.isAilyChatTool = () => false;
    expect((await host.reportChatSessionIssue()).skipped).toBeTrue();
  });
});

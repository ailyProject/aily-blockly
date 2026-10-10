import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ActionService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import { ProjectApplicationAdapter } from '../../project/project-application.adapter';
import { HeaderComponent } from '../../../main-window/components/header/header.component';

describe('real unsaved-state Action feedback boundary', () => {
  function fixture() {
    const actions = new ActionService();
    const project: any = Object.create(ProjectService.prototype);
    Object.defineProperty(project, 'currentProjectPath', { value: '/project', writable: true });
    project.getProjectMode = () => 'blockly'; project.getProjectDependencySession();
    const adapter: any = Object.assign(Object.create(ProjectApplicationAdapter.prototype), { actionService: actions, projectService: project });
    project.hasUnsavedChanges = () => adapter.hasUnsavedBlocklyChanges();
    const dialog = new Subject<any>();
    const view: any = Object.assign(Object.create(HeaderComponent.prototype), {
      projectService: project, message: { error: jasmine.createSpy('error') },
      modal: { create: jasmine.createSpy('dialog').and.returnValue({ afterClose: dialog }) },
    });
    return { actions, view, project, dialog, confirm: () => view.checkUnsavedChanges('close') as Promise<boolean> };
  }

  it('offers explicit discard after a real timeout and ignores its late clean reply', fakeAsync(() => {
    const { actions, view, dialog, confirm } = fixture();
    let reply!: (value: unknown) => void;
    const stop = actions.listen('project-check-unsaved', () => new Promise(resolve => { reply = resolve; }));
    const settled = jasmine.createSpy('settled'); confirm().then(settled);
    tick(14999); expect(settled).not.toHaveBeenCalled();
    tick(1); expect(settled).not.toHaveBeenCalled();
    expect(view.modal.create).toHaveBeenCalledTimes(1);
    reply({ hasUnsavedChanges: false }); flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();
    dialog.next({ result: 'continue' }); flushMicrotasks();
    expect(settled).toHaveBeenCalledOnceWith(true);
    expect(settled).toHaveBeenCalledTimes(1); stop();
  }));

  for (const kind of ['sync rejection', 'async rejection', 'missing boolean', 'string boolean']) {
    it(`allows the user to cancel closing after ${kind}`, fakeAsync(() => {
      const { actions, view, dialog, confirm } = fixture();
      const stop = actions.listen('project-check-unsaved', () => {
        if (kind === 'sync rejection') throw new Error('editor unavailable');
        if (kind === 'async rejection') return Promise.reject(new Error('editor unavailable'));
        return kind === 'missing boolean' ? {} : { hasUnsavedChanges: 'false' };
      });
      const settled = jasmine.createSpy('settled'); confirm().then(settled); flushMicrotasks();
      expect(settled).not.toHaveBeenCalled();
      expect(view.modal.create).toHaveBeenCalledTimes(1);
      expect(view.modal.create.calls.mostRecent().args[0].nzData.buttons.map((b: any) => b.action)).toEqual(['cancel', 'continue']);
      dialog.next({ result: 'cancel' }); flushMicrotasks();
      expect(settled).toHaveBeenCalledOnceWith(false);
      tick(15000); expect(settled).toHaveBeenCalledTimes(1); stop();
    }));
  }

  it('allows retrying a close whose dependency work was already cancelled', fakeAsync(() => {
    const { actions, project, confirm } = fixture();
    project.dependencyLifecycle.cancel('/project');
    const stop = actions.listen('project-check-unsaved', () => ({ hasUnsavedChanges: false }));
    const settled = jasmine.createSpy('settled'); confirm().then(settled); flushMicrotasks();
    expect(settled).toHaveBeenCalledOnceWith(true);
    stop();
  }));

  it('does not let a stale discard confirmation close a replacement project', fakeAsync(() => {
    const { actions, project, dialog, confirm } = fixture();
    const stop = actions.listen('project-check-unsaved', () => { throw new Error('unavailable'); });
    const settled = jasmine.createSpy('settled'); confirm().then(settled); flushMicrotasks();
    project.currentProjectPath = '/replacement';
    dialog.next({ result: 'continue' }); flushMicrotasks();
    expect(settled).toHaveBeenCalledOnceWith(false);
    stop();
  }));

  it('returns the discard choice through the native window-close handshake', fakeAsync(() => {
    const { actions, view, dialog } = fixture();
    const original = window['iWindow'];
    window['iWindow'] = { confirmClose: jasmine.createSpy('confirm') };
    try {
      const stop = actions.listen('project-check-unsaved', () => { throw new Error('unavailable'); });
      view.confirmWindowClose({ requestId: 'native-close' }); flushMicrotasks();
      expect(window['iWindow'].confirmClose).not.toHaveBeenCalled();
      dialog.next({ result: 'continue' }); flushMicrotasks();
      expect(window['iWindow'].confirmClose).toHaveBeenCalledOnceWith('native-close', true);
      stop();
    } finally { window['iWindow'] = original; }
  }));

  it('accepts an explicit clean reply without a save dialog', fakeAsync(() => {
    const { actions, view, confirm } = fixture();
    const stop = actions.listen('project-check-unsaved', () => ({ hasUnsavedChanges: false }));
    const settled = jasmine.createSpy('settled'); confirm().then(settled); flushMicrotasks();
    expect(settled).toHaveBeenCalledOnceWith(true);
    expect(view.message.error).not.toHaveBeenCalled(); expect(view.modal.create).not.toHaveBeenCalled(); stop();
  }));

  for (const failure of [false, true]) it(`retains eager observable feedback for late subscribers (failure=${failure})`, fakeAsync(() => {
    const actions = new ActionService(), handler = jasmine.createSpy('handler').and.callFake(() => {
      if (failure) throw new Error('synchronous failure');
      return { hasUnsavedChanges: false };
    });
    const stop = actions.listen('project-check-unsaved', handler);
    const reply = actions.dispatchWithFeedback('project-check-unsaved', {}, 15000);
    expect(handler).toHaveBeenCalledTimes(1); flushMicrotasks();
    const first = jasmine.createSpy('first'), second = jasmine.createSpy('second'), complete = jasmine.createSpy('complete');
    reply.subscribe({ next: first, complete }); reply.subscribe(second);
    expect(first).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success: !failure }));
    expect(second).toHaveBeenCalledOnceWith(first.calls.first().args[0]); expect(complete).toHaveBeenCalledTimes(1);
    tick(15000); expect(first).toHaveBeenCalledTimes(1); expect(handler).toHaveBeenCalledTimes(1); stop();
  }));
});

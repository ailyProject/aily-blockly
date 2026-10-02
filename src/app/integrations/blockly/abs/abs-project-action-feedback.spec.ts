import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
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
    const view: any = Object.assign(Object.create(HeaderComponent.prototype), {
      projectService: project, message: { error: jasmine.createSpy('error') },
      modal: { create: jasmine.createSpy('dialog') },
    });
    return { actions, view, project, confirm: () => view.checkUnsavedChanges('close') as Promise<boolean> };
  }

  it('rejects a real timeout and ignores its late clean reply', fakeAsync(() => {
    const { actions, view, confirm } = fixture();
    let reply!: (value: unknown) => void;
    const stop = actions.listen('project-check-unsaved', () => new Promise(resolve => { reply = resolve; }));
    const settled = jasmine.createSpy('settled'); confirm().then(settled);
    tick(14999); expect(settled).not.toHaveBeenCalled();
    tick(1); expect(settled).toHaveBeenCalledOnceWith(false);
    expect(view.message.error).toHaveBeenCalled(); expect(view.modal.create).not.toHaveBeenCalled();
    reply({ hasUnsavedChanges: false }); flushMicrotasks();
    expect(settled).toHaveBeenCalledTimes(1); stop();
  }));

  for (const kind of ['sync rejection', 'async rejection', 'missing boolean', 'string boolean']) {
    it(`fails closed promptly on ${kind}`, fakeAsync(() => {
      const { actions, view, confirm } = fixture();
      const stop = actions.listen('project-check-unsaved', () => {
        if (kind === 'sync rejection') throw new Error('editor unavailable');
        if (kind === 'async rejection') return Promise.reject(new Error('editor unavailable'));
        return kind === 'missing boolean' ? {} : { hasUnsavedChanges: 'false' };
      });
      const settled = jasmine.createSpy('settled'); confirm().then(settled); flushMicrotasks();
      expect(settled).toHaveBeenCalledOnceWith(false);
      expect(view.message.error).toHaveBeenCalled(); expect(view.modal.create).not.toHaveBeenCalled();
      tick(15000); expect(settled).toHaveBeenCalledTimes(1); stop();
    }));
  }

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

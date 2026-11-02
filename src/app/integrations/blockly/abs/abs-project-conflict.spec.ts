import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService, isProjectSaveConflict, type ProjectConflictChoice } from '@domain/project/public-api';
import { HeaderComponent } from '../../../main-window/components/header/header.component';

const project = '/isolated/current', token = `sha256:${'a'.repeat(64)}`;
const conflict = () => Object.assign(new Error('Competing saved program.'), { code: 'ABS_DUAL_EDIT_CONFLICT' });
const resolved = (choice: ProjectConflictChoice) => ({ project, choice, refreshed: choice === 'replace_view', generation: 'generation-1',
  projectSaved: true, generatedCodePublished: true, partial: false });

describe('project conflict domain boundary', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    Object.defineProperty(service, 'currentProjectPath', { value: project, writable: true });
    service.stateSubject = new BehaviorSubject('loaded');
    service.getProjectMode = jasmine.createSpy('mode').and.returnValue('blockly');
    const application = {
      inspectBlocklyConflict: jasmine.createSpy('inspect').and.resolveTo({ project, token }),
      resolveBlocklyConflict: jasmine.createSpy('resolve').and.callFake(async (_path, choice) => resolved(choice)),
    };
    Object.defineProperty(service, 'application', { value: application });
    return { service, application };
  }

  for (const choice of ['keep_view', 'replace_view'] as const) it(`uses the exact ${choice} capability and acknowledges only confirmed persistence`, async () => {
    const { service, application } = fixture();
    const offer = await service.inspectSaveConflict(project);
    expect(offer).toEqual({ project, token });
    expect(await service.resolveSaveConflict(project, choice, offer.token)).toEqual(resolved(choice));
    expect(application.resolveBlocklyConflict).toHaveBeenCalledOnceWith(project, choice, token);
    expect(service.stateSubject.value).toBe('saved');
  });

  for (const mode of ['coder', null]) it(`does not expose Blockly conflict authority in ${mode} mode`, async () => {
    const { service, application } = fixture(); service.getProjectMode.and.returnValue(mode);
    await expectAsync(service.inspectSaveConflict(project)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_CONFLICT_CONTEXT_CHANGED' }));
    await expectAsync(service.resolveSaveConflict(project, 'keep_view', token)).toBeRejected();
    expect(application.inspectBlocklyConflict).not.toHaveBeenCalled(); expect(application.resolveBlocklyConflict).not.toHaveBeenCalled();
  });

  it('rejects foreign projects, malformed tokens and unrecognized choices before mutation', async () => {
    const { service, application } = fixture();
    await expectAsync(service.inspectSaveConflict('/other')).toBeRejected();
    for (const [choice, value] of [['keep_view', 'force'], ['overwrite', token], ['replace_view', `sha256:${'A'.repeat(64)}`]]) {
      await expectAsync(service.resolveSaveConflict(project, choice, value)).toBeRejected();
    }
    expect(application.inspectBlocklyConflict).not.toHaveBeenCalled(); expect(application.resolveBlocklyConflict).not.toHaveBeenCalled();
  });

  it('rejects a changed activation during inspection instead of adopting its returned token', async () => {
    const { service, application } = fixture();
    application.inspectBlocklyConflict.and.callFake(async () => { service.currentProjectPath = '/replacement'; return { project, token }; });
    await expectAsync(service.inspectSaveConflict(project)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_CONFLICT_CONTEXT_CHANGED' }));
    expect(application.resolveBlocklyConflict).not.toHaveBeenCalled();
  });

  it('rejects reopening the same path during inspection', async () => {
    const { service, application } = fixture(); let session = { signal: new AbortController().signal };
    service.dependencyLifecycleState = { get: () => session };
    application.inspectBlocklyConflict.and.callFake(async () => { session = { signal: new AbortController().signal }; return { project, token }; });
    await expectAsync(service.inspectSaveConflict(project)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_CONFLICT_CONTEXT_CHANGED' }));
    expect(application.resolveBlocklyConflict).not.toHaveBeenCalled();
  });

  for (const patch of [{ project: '/other' }, { token: 'force' }]) it(`rejects an invalid inspection ${JSON.stringify(patch)}`, async () => {
    const { service, application } = fixture(); application.inspectBlocklyConflict.and.resolveTo({ project, token, ...patch });
    await expectAsync(service.inspectSaveConflict(project)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_CONFLICT_INVALID' }));
  });

  for (const patch of [{ project: '/other' }, { choice: 'replace_view' }, { refreshed: true }, { generation: '' },
    { projectSaved: false }, { partial: true, error: 'generated publication pending' }]) it(`does not mark an unconfirmed result saved: ${JSON.stringify(patch)}`, async () => {
    const { service, application } = fixture(); application.resolveBlocklyConflict.and.resolveTo({ ...resolved('keep_view'), ...patch });
    await expectAsync(service.resolveSaveConflict(project, 'keep_view', token)).toBeRejected();
    expect(service.stateSubject.value).toBe('error');
  });

  it('does not publish error or saved state into a replacement project after resolution', async () => {
    const { service, application } = fixture();
    application.resolveBlocklyConflict.and.callFake(async () => {
      service.currentProjectPath = '/replacement'; service.stateSubject.next('loaded'); return resolved('keep_view');
    });
    await expectAsync(service.resolveSaveConflict(project, 'keep_view', token)).toBeRejected();
    expect(service.stateSubject.value).toBe('loaded');
  });

  it('preserves a typed save failure without changing the original dispatch or retrying it', async () => {
    const { service, application } = fixture();
    const dispatch = jasmine.createSpy('save').and.resolveTo({ success: false, code: 'ABS_DUAL_EDIT_CONFLICT', error: 'conflict' });
    Object.assign(application, { dispatchProjectSave: dispatch });
    expect(await service.save()).toEqual({ success: false, code: 'ABS_DUAL_EDIT_CONFLICT', error: 'conflict', path: project });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(application.resolveBlocklyConflict).not.toHaveBeenCalled();
  });
});

describe('manual save and quit conflict choices', () => {
  function fixture() {
    const dialogs: Subject<any>[] = [];
    const service: any = {
      currentProjectPath: project,
      captureCurrentProjectGuard() { const path = this.currentProjectPath; return () => this.currentProjectPath === path; },
      getProjectMode: jasmine.createSpy('mode').and.returnValue('blockly'),
      save: jasmine.createSpy('save').and.resolveTo({ success: false, code: 'ABS_DUAL_EDIT_CONFLICT', error: 'conflict' }),
      inspectSaveConflict: jasmine.createSpy('inspect').and.resolveTo({ project, token }),
      resolveSaveConflict: jasmine.createSpy('resolve').and.callFake(async (_path, choice) => resolved(choice)),
      hasUnsavedChanges: jasmine.createSpy('dirty').and.rejectWith(conflict()),
      discardAllLibraryChanges: jasmine.createSpy('discard').and.resolveTo(),
    };
    const view: any = Object.assign(Object.create(HeaderComponent.prototype), {
      projectService: service, ngZone: new NgZone({}),
      message: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') },
      modal: { create: jasmine.createSpy('dialog').and.callFake(() => {
        const subject = new Subject<any>(); dialogs.push(subject); return { afterClose: subject };
      }) },
    });
    return { service, view, dialogs };
  }

  for (const choice of ['keep_view', 'replace_view'] as const) it(`offers explicit ${choice} after one failed Ctrl+S/menu save`, fakeAsync(() => {
    const { service, view, dialogs } = fixture(), done = jasmine.createSpy('done');
    view.process({ action: 'project-save' }, null, 'manual').then(done); flushMicrotasks();
    expect(view.modal.create).toHaveBeenCalledTimes(1);
    const data = view.modal.create.calls.first().args[0].nzData;
    expect(data.buttons.map(button => button.action)).toEqual(['cancel', 'keep_view', 'replace_view']);
    expect(data.buttons[1].text).toBe('保留当前视图并保存'); expect(data.buttons[2].text).toBe('使用最新版本并刷新');
    dialogs[0].next({ result: choice }); flushMicrotasks();
    expect(service.save).toHaveBeenCalledTimes(1); expect(service.resolveSaveConflict).toHaveBeenCalledOnceWith(project, choice, token);
    expect(view.message.error).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledTimes(1);
  }));

  it('does not show an Agent save a UI dialog', async () => {
    const { service, view } = fixture(); await view.process({ action: 'project-save' }, null, 'ai');
    expect(service.save).toHaveBeenCalledTimes(1); expect(service.inspectSaveConflict).not.toHaveBeenCalled();
    expect(view.modal.create).not.toHaveBeenCalled();
  });

  it('keeps the actual Agent menu-save entry noninteractive and returns its real failure', async () => {
    const { service, view } = fixture(), item = { action: 'project-save', name: 'Save' };
    view.createHeaderMenuAutomationSnapshot = () => ({ sourceById: new Map([['save', item]]) });
    view.showInRouter = () => true; view.translate = { instant: value => value };
    const result = await view.executeHeaderMenuAutomationItem('save');
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_DUAL_EDIT_CONFLICT');
    expect(service.save).toHaveBeenCalledTimes(1); expect(service.inspectSaveConflict).not.toHaveBeenCalled();
    expect(view.modal.create).not.toHaveBeenCalled();
  });

  it('preserves the Coder menu save route without asking for Blockly conflict authority', async () => {
    const { service, view } = fixture(); service.getProjectMode.and.returnValue('coder');
    await view.process({ action: 'project-save' }, null, 'manual');
    expect(service.save).toHaveBeenCalledTimes(1); expect(service.inspectSaveConflict).not.toHaveBeenCalled();
    expect(view.modal.create).not.toHaveBeenCalled();
  });

  it('does not inspect or show a conflict choice after an ordinary confirmed save', async () => {
    const { service, view } = fixture(); service.save.and.resolveTo({ success: true });
    await view.process({ action: 'project-save' }, null, 'manual');
    expect(service.save).toHaveBeenCalledTimes(1); expect(service.inspectSaveConflict).not.toHaveBeenCalled();
    expect(view.modal.create).not.toHaveBeenCalled();
  });

  for (const code of ['ABS_COMMIT_UNCERTAIN', 'ABS_OUTCOME_UNKNOWN', 'ACTION_FEEDBACK_TIMEOUT', 'EACCES', undefined]) {
    it(`does not turn ${code} into automatic resolution or a second save`, async () => {
      const { service, view } = fixture(); service.save.and.resolveTo({ success: false, code, error: 'same words: conflict' });
      await view.process({ action: 'project-save' });
      expect(service.inspectSaveConflict).not.toHaveBeenCalled(); expect(service.resolveSaveConflict).not.toHaveBeenCalled();
      expect(view.modal.create).not.toHaveBeenCalled(); expect(service.save).toHaveBeenCalledTimes(1); expect(view.message.error).toHaveBeenCalled();
    });
  }

  it('leaves a cancelled conflict unresolved and allows a subsequent explicit retry', fakeAsync(() => {
    const { service, view, dialogs } = fixture(), done = jasmine.createSpy('done');
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    dialogs[0].next({ result: 'cancel' }); flushMicrotasks();
    expect(done).toHaveBeenCalledOnceWith(false); expect(service.resolveSaveConflict).not.toHaveBeenCalled();
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    dialogs[1].next({ result: 'keep_view' }); flushMicrotasks();
    expect(done.calls.allArgs()).toEqual([[false], [true]]); expect(service.discardAllLibraryChanges).not.toHaveBeenCalled();
  }));

  it('blocks duplicate saves while the explicit choice is pending', fakeAsync(() => {
    const { service, view, dialogs } = fixture();
    view.process({ action: 'project-save' }); flushMicrotasks();
    view.process({ action: 'project-save' }); flushMicrotasks();
    expect(service.save).toHaveBeenCalledTimes(1); expect(view.modal.create).toHaveBeenCalledTimes(1);
    dialogs[0].next({ result: 'cancel' }); flushMicrotasks();
  }));

  it('keeps a second quit blocked while conflict resolution is pending', fakeAsync(() => {
    const { service, view, dialogs } = fixture(), second = jasmine.createSpy('second');
    view.checkUnsavedChanges('close'); flushMicrotasks();
    view.checkUnsavedChanges('close').then(second); flushMicrotasks();
    expect(second).toHaveBeenCalledOnceWith(false); expect(service.inspectSaveConflict).toHaveBeenCalledTimes(1);
    dialogs[0].next({ result: 'cancel' }); flushMicrotasks();
  }));

  it('does not leave a permanent dialog guard when modal creation fails', fakeAsync(() => {
    const { view, dialogs } = fixture(), done = jasmine.createSpy('done');
    view.modal.create.and.callFake(() => { throw new Error('UI unavailable'); });
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    expect(done).toHaveBeenCalledOnceWith(false); expect(view.unsaveDialogOpen).toBeFalse();
    expect(view.projectConflictResolving).toBeFalse();
    view.modal.create.and.callFake(() => { const next = new Subject<any>(); dialogs.push(next); return { afterClose: next }; });
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    dialogs[0].next({ result: 'cancel' }); flushMicrotasks(); expect(done).toHaveBeenCalledTimes(2);
  }));

  it('does not use an old dialog to mutate a replacement project', fakeAsync(() => {
    const { service, view, dialogs } = fixture(), done = jasmine.createSpy('done');
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    service.currentProjectPath = '/replacement'; dialogs[0].next({ result: 'replace_view' }); flushMicrotasks();
    expect(done).toHaveBeenCalledOnceWith(false); expect(service.resolveSaveConflict).not.toHaveBeenCalled();
  }));

  for (const outcome of ['archive-failure', 'partial']) it(`keeps quit blocked after ${outcome}`, fakeAsync(() => {
    const { service, view, dialogs } = fixture(), done = jasmine.createSpy('done');
    if (outcome === 'archive-failure') service.resolveSaveConflict.and.rejectWith(new Error('archive failed'));
    else service.resolveSaveConflict.and.resolveTo({ ...resolved('replace_view'), partial: true });
    view.checkUnsavedChanges('close', { quitting: true }).then(done); flushMicrotasks();
    dialogs[0].next({ result: 'replace_view' }); flushMicrotasks();
    expect(done).toHaveBeenCalledOnceWith(false); expect(service.discardAllLibraryChanges).not.toHaveBeenCalled();
  }));

  it('offers the same resolver when save-before-quit discovers the conflict only after the ordinary dialog', fakeAsync(() => {
    const { service, view, dialogs } = fixture(), done = jasmine.createSpy('done'); service.hasUnsavedChanges.and.resolveTo(true);
    view.checkUnsavedChanges('close').then(done); flushMicrotasks();
    dialogs[0].next({ result: 'save' }); flushMicrotasks();
    expect(dialogs.length).toBe(2); dialogs[1].next({ result: 'replace_view' }); flushMicrotasks();
    expect(done).toHaveBeenCalledOnceWith(true); expect(service.save).toHaveBeenCalledOnceWith(project, 15000);
    expect(service.resolveSaveConflict).toHaveBeenCalledOnceWith(project, 'replace_view', token);
  }));

  it('does not treat a matching English message as a conflict capability', () => {
    expect(isProjectSaveConflict(new Error('Saved ABI and workspace diverged.'))).toBeFalse();
    expect(isProjectSaveConflict({ code: 'ABS_DUAL_EDIT_CONFLICT' })).toBeTrue();
  });
});

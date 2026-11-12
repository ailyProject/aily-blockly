import { Subject } from 'rxjs';
import { NgZone } from '@angular/core';
import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { HeaderComponent } from '../../../main-window/components/header/header.component';
import { ProjectNewComponent } from '../../../pages/project-new/project-new.component';

describe('automatic same-project runtime recovery at UI boundaries', () => {
  function fixture() {
    const closed = new Subject<any>();
    let blocked = true;
    const project = { currentProjectPath: '/source', captureCurrentProjectGuard: () => () => project.currentProjectPath === '/source',
      getProjectMode: () => 'blockly', hasUnsavedChanges: jasmine.createSpy().and.resolveTo(true),
      hasBlocklyRuntimeRecovery: () => blocked, save: jasmine.createSpy().and.resolveTo({ success: true }),
      saveRecoveryAs: jasmine.createSpy(), recoverBlocklyRuntimeInPlace: jasmine.createSpy().and.callFake(async () => {
        blocked = false; return { ready: true };
      }) };
    const header: any = Object.assign(Object.create(HeaderComponent.prototype), { projectService: project, ngZone: new NgZone({}),
      message: { success: jasmine.createSpy(), error: jasmine.createSpy() },
      resolveSaveConflictFromUi: jasmine.createSpy().and.resolveTo(undefined),
      selectSaveAsFolder: jasmine.createSpy(), modal: { create: jasmine.createSpy().and.returnValue({ afterClose: closed }) } });
    return { header, project, closed };
  }

  for (const action of ['close', 'open', 'new']) it(`restores before the ordinary unsaved decision for ${action}`, fakeAsync(() => {
    const { header, project, closed } = fixture();
    let result;
    header.checkUnsavedChanges(action).then((value: boolean) => { result = value; });
    flushMicrotasks();
    expect(project.recoverBlocklyRuntimeInPlace).toHaveBeenCalledOnceWith('/source');
    expect(header.modal.create.calls.mostRecent().args[0].nzData).toEqual({ action });
    closed.next({ result: 'save' });
    flushMicrotasks();
    expect(result).toBeTrue();
    expect(project.save).toHaveBeenCalledOnceWith('/source');
    expect(project.saveRecoveryAs).not.toHaveBeenCalled();
    expect(header.selectSaveAsFolder).not.toHaveBeenCalled();
  }));

  for (const recovery of [{ ready: false, cancelled: true }, { ready: false, message: 'unavailable dependency' }])
    it('retains the current project when recovery is cancelled or cannot complete', async () => {
      const { header, project } = fixture();
      project.recoverBlocklyRuntimeInPlace.and.resolveTo(recovery);
      expect(await header.checkUnsavedChanges('close')).toBeFalse();
      expect(header.modal.create).not.toHaveBeenCalled();
      expect(project.save).not.toHaveBeenCalled();
      expect(project.saveRecoveryAs).not.toHaveBeenCalled();
    });

  it('cancelling the ordinary leave choice does not discard or save the restored view', fakeAsync(() => {
    const { header, project, closed } = fixture();
    let result;
    header.checkUnsavedChanges('close').then((value: boolean) => { result = value; });
    flushMicrotasks();
    closed.next({ result: 'cancel' });
    flushMicrotasks();
    expect(result).toBeFalse();
    expect(project.save).not.toHaveBeenCalled();
    expect(project.currentProjectPath).toBe('/source');
  }));

  it('a late recovery does not close or save a replacement project', async () => {
    const { header, project } = fixture();
    project.recoverBlocklyRuntimeInPlace.and.callFake(async () => { project.currentProjectPath = '/replacement'; return { ready: true }; });
    expect(await header.checkUnsavedChanges('open')).toBeFalse();
    expect(project.save).not.toHaveBeenCalled();
    expect(header.modal.create).not.toHaveBeenCalled();
  });

  it('retires the retained view only on the final accepted quit discard', fakeAsync(() => {
    const { header, project, closed } = fixture();
    const discard = jasmine.createSpy('discard').and.resolveTo(undefined);
    (project as any).acknowledgeBlocklyRecoveryDiscard = discard;
    (project as any).discardLibraryChangesBeforeQuit = jasmine.createSpy('libraries').and.resolveTo(undefined);
    let result;
    header.checkUnsavedChanges('close', { quitting: true }).then((value: boolean) => { result = value; });
    flushMicrotasks();
    expect(discard).not.toHaveBeenCalled();
    closed.next({ result: 'continue' });
    flushMicrotasks();
    expect(discard).toHaveBeenCalledOnceWith('/source');
    expect(result).toBeTrue();
  }));

  it('new-project navigation also restores in place without choosing a copy', fakeAsync(() => {
    const { header, project, closed } = fixture();
    const wizard: any = Object.assign(Object.create(ProjectNewComponent.prototype), {
      projectService: project, router: { url: '/main/blockly-editor' }, message: header.message, nzModal: header.modal });
    let result;
    wizard.confirmSwitchWithUnsavedIfNeeded().then((value: boolean) => { result = value; });
    flushMicrotasks();
    expect(project.recoverBlocklyRuntimeInPlace).toHaveBeenCalledOnceWith('/source');
    expect(header.modal.create.calls.mostRecent().args[0].nzData).toEqual({ action: 'open' });
    closed.next({ result: 'cancel' });
    flushMicrotasks();
    expect(result).toBeFalse();
    expect(project.saveRecoveryAs).not.toHaveBeenCalled();
  }));
});

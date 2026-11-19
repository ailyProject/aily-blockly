import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { HeaderComponent } from './header.component';

describe('Header original save completion', () => {
  let header: any;
  beforeEach(() => {
    header = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/isolated/project',
      captureCurrentProjectGuard() {
        const path = this.currentProjectPath;
        return () => this.currentProjectPath === path;
      },
      save: jasmine.createSpy('save'),
    };
    header.message = { error: jasmine.createSpy('error') };
    header.resolveSaveConflictFromUi = jasmine.createSpy('conflict').and.resolveTo(undefined);
  });

  it('retains one UI submission beyond the former five-second feedback deadline', fakeAsync(() => {
    let finish!: (result: any) => void;
    header.projectService.save.and.returnValue(new Promise(resolve => { finish = resolve; }));
    let saved: boolean | undefined;
    header.saveProjectFromUi().then((result: boolean) => { saved = result; });
    tick(6000);
    expect(header.projectSavingFromUi).toBeTrue();
    expect(saved).toBeUndefined();
    expect(header.message.error).not.toHaveBeenCalled();
    header.saveProjectFromUi();
    expect(header.projectService.save).toHaveBeenCalledOnceWith('/isolated/project');
    finish({ success: true }); flushMicrotasks();
    expect(saved).toBeTrue();
    expect(header.projectSavingFromUi).toBeFalse();
  }));

  it('does not acknowledge a replacement project from the old task completion', fakeAsync(() => {
    let finish!: (result: any) => void;
    header.projectService.save.and.returnValue(new Promise(resolve => { finish = resolve; }));
    let saved: boolean | undefined;
    header.saveProjectFromUi().then((result: boolean) => { saved = result; });
    header.projectService.currentProjectPath = '/isolated/other';
    finish({ success: true }); flushMicrotasks();
    expect(saved).toBeFalse();
    expect(header.message.error).not.toHaveBeenCalled();
  }));

  it('reports the original disk failure without retrying the write', async () => {
    header.projectService.save.and.resolveTo({ success: false, error: 'disk full' });
    expect(await header.saveProjectFromUi()).toBeFalse();
    expect(header.message.error).toHaveBeenCalledOnceWith('disk full');
    expect(header.projectService.save).toHaveBeenCalledTimes(1);
    expect(header.projectSavingFromUi).toBeFalse();
  });

  it('automatically restores the same runtime before saving without a picker or dialog', async () => {
    let blocked = true;
    header.projectService.hasBlocklyRuntimeRecovery = () => blocked;
    header.projectService.recoverBlocklyRuntimeInPlace = jasmine.createSpy('restore').and.callFake(async (path: string) => {
      expect(path).toBe('/isolated/project');
      blocked = false;
      return { ready: true };
    });
    header.projectService.save.and.callFake(async () => {
      expect(blocked).toBeFalse();
      return { success: true };
    });
    header.modal = { create: jasmine.createSpy('modal') };
    header.selectSaveAsFolder = jasmine.createSpy('picker');
    expect(await header.saveProjectFromUi()).toBeTrue();
    expect(header.projectService.recoverBlocklyRuntimeInPlace).toHaveBeenCalledTimes(1);
    expect(header.projectService.save).toHaveBeenCalledTimes(1);
    expect(header.modal.create).not.toHaveBeenCalled();
    expect(header.selectSaveAsFolder).not.toHaveBeenCalled();
  });

  it('does not save or offer a recovery copy after recovery cancellation', async () => {
    header.projectService.hasBlocklyRuntimeRecovery = () => true;
    header.projectService.recoverBlocklyRuntimeInPlace = jasmine.createSpy('restore').and.resolveTo({ ready: false, cancelled: true });
    header.modal = { create: jasmine.createSpy('modal') };
    expect(await header.saveProjectFromUi()).toBeFalse();
    expect(header.projectService.save).not.toHaveBeenCalled();
    expect(header.projectService.recoverBlocklyRuntimeInPlace).toHaveBeenCalledTimes(1);
    expect(header.modal.create).not.toHaveBeenCalled();
    expect(header.message.error).not.toHaveBeenCalled();
  });

  it('ignores an old runtime recovery after the current project is replaced', async () => {
    header.projectService.hasBlocklyRuntimeRecovery = () => true;
    header.projectService.recoverBlocklyRuntimeInPlace = jasmine.createSpy('restore').and.callFake(async () => {
      header.projectService.currentProjectPath = '/isolated/newer-project';
      return { ready: true };
    });
    expect(await header.saveProjectFromUi()).toBeFalse();
    expect(header.projectService.save).not.toHaveBeenCalled();
    expect(header.message.error).not.toHaveBeenCalled();
  });

  it('accepts a committed document while its generated code waits for the active build', async () => {
    header.autoSaveState = 'error';
    header.autoSaveError = 'previous failure';
    header.cd = { markForCheck: jasmine.createSpy('markForCheck') };
    header.projectService.save.and.resolveTo({ success: false, projectSaved: true,
      generatedCodePublished: false, partial: true, code: 'BUILD_WORKSPACE_BUSY', error: 'BUILD_WORKSPACE_BUSY: busy' });
    expect(await header.saveProjectFromUi()).toBeTrue();
    expect(header.message.error).not.toHaveBeenCalled();
    expect(header.projectService.save).toHaveBeenCalledTimes(1);
    expect(header.autoSaveState).toBe('saved');
    expect(header.autoSaveError).toBe('');
    expect(header.cd.markForCheck).toHaveBeenCalledTimes(1);
  });

  it('still reports contention before any confirmed document commit', async () => {
    header.projectService.save.and.resolveTo({ success: false, projectSaved: false,
      code: 'BUILD_WORKSPACE_BUSY', error: 'document not saved' });
    expect(await header.saveProjectFromUi()).toBeFalse();
    expect(header.message.error).toHaveBeenCalledOnceWith('document not saved');
  });
});

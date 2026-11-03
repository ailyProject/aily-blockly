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
});

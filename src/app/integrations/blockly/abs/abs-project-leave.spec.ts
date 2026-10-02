import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { HeaderComponent } from '../../../main-window/components/header/header.component';
import { ProjectNewComponent } from '../../../pages/project-new/project-new.component';

function projectFixture(overrides: Record<string, unknown>) {
  const project: any = Object.assign(Object.create(ProjectService.prototype), overrides);
  Object.defineProperty(project, 'currentProjectPath', { value: '/original', writable: true });
  project.getProjectDependencySession();
  return project;
}

function replaceSession(project: any): void {
  const previous = project.dependencyLifecycle.cancel(project.currentProjectPath);
  project.dependencyLifecycle.release(previous);
  project.getProjectDependencySession();
}

describe('save-before-leaving confirmation', () => {
  for (const entry of ['header', 'wizard']) {
    function fixture() {
      const dialog = new Subject<any>();
      const project = projectFixture({ getProjectMode: () => 'blockly',
        hasUnsavedChanges: jasmine.createSpy('dirty').and.resolveTo(true),
        save: jasmine.createSpy('save').and.resolveTo({ success: true }) });
      const view: any = Object.create(entry === 'header' ? HeaderComponent.prototype : ProjectNewComponent.prototype);
      view.projectService = project;
      view.isOnEditorRoute = () => true;
      view.message = { error: jasmine.createSpy('error') };
      view.modal = view.nzModal = { create: jasmine.createSpy('dialog').and.returnValue({ afterClose: dialog }) };
      return { view, project, dialog, confirm: () => entry === 'header'
        ? view.checkUnsavedChanges('close') : view.confirmSwitchWithUnsavedIfNeeded() };
    }
    for (const result of [{ success: false, error: 'disk full' }, undefined, { success: 'true' }]) {
      it(`${entry} refuses an unconfirmed save even when its Promise resolves`, async () => {
        const { project, view, dialog, confirm } = fixture(); project.save.and.resolveTo(result);
        const pending = confirm(); await Promise.resolve(); dialog.next({ result: 'save' });
        expect(await pending).toBeFalse(); expect(view.message.error).toHaveBeenCalled();
        expect(project.save).toHaveBeenCalledOnceWith('/original', 15_000);
      });
    }
    for (const action of ['save', 'continue', 'cancel']) it(`${entry} retains the normal ${action} choice`, async () => {
      const { project, dialog, confirm } = fixture();
      const pending = confirm(); await Promise.resolve(); dialog.next({ result: action });
      expect(await pending).toBe(action !== 'cancel');
      expect(project.save.calls.count()).toBe(action === 'save' ? 1 : 0);
    });
    for (const action of ['save', 'continue']) it(`${entry} cannot apply an old ${action} choice to another project`, async () => {
      const { project, dialog, confirm } = fixture();
      const pending = confirm(); await Promise.resolve(); project.currentProjectPath = '/replacement';
      dialog.next({ result: action }); expect(await pending).toBeFalse(); expect(project.save).not.toHaveBeenCalled();
    });
    for (const action of ['save', 'continue']) it(`${entry} cannot apply an old ${action} choice after reopening the same path`, async () => {
      const { project, dialog, confirm } = fixture();
      const pending = confirm(); await Promise.resolve(); replaceSession(project);
      dialog.next({ result: action }); expect(await pending).toBeFalse(); expect(project.save).not.toHaveBeenCalled();
    });
    for (const phase of ['query', 'save']) it(`${entry} rejects an old ${phase} reply from the same path's previous activation`, async () => {
      const { project, dialog, confirm } = fixture();
      if (phase === 'query') {
        project.hasUnsavedChanges.and.callFake(async () => { replaceSession(project); return false; });
        expect(await confirm()).toBeFalse();
      } else {
        project.save.and.callFake(async () => { replaceSession(project); return { success: true }; });
        const pending = confirm(); await Promise.resolve(); dialog.next({ result: 'save' });
        expect(await pending).toBeFalse();
      }
    });
    it(`${entry} ignores unrelated project preparation but rejects cancellation of its own session`, async () => {
      const { project, dialog, confirm } = fixture();
      let pending = confirm(); await Promise.resolve(); project.getProjectDependencySession('/other');
      dialog.next({ result: 'continue' }); expect(await pending).toBeTrue();
      pending = confirm(); await Promise.resolve(); project.dependencyLifecycle.cancel('/original');
      dialog.next({ result: 'continue' }); expect(await pending).toBeFalse();
    });
    it(`${entry} rejects a clean reply or completed save belonging to a replaced project`, async () => {
      const { project, view, dialog, confirm } = fixture();
      project.hasUnsavedChanges.and.callFake(async () => { project.currentProjectPath = '/other'; return false; });
      expect(await confirm()).toBeFalse(); expect(view.modal.create).not.toHaveBeenCalled();
      project.hasUnsavedChanges.and.resolveTo(true);
      project.save.and.callFake(async () => { project.currentProjectPath = '/new'; return { success: true }; });
      const pending = confirm(); await Promise.resolve(); dialog.next({ result: 'save' });
      expect(await pending).toBeFalse();
    });
  }
});

describe('domain save completion and project ownership', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject('/original');
    service.stateSubject = new BehaviorSubject('loaded');
    service.getProjectMode = () => 'coder';
    const dispatch = jasmine.createSpy('dispatch').and.resolveTo({ success: true });
    Object.defineProperty(service, 'application', { value: { dispatchProjectSave: dispatch } });
    service.copyPackageJsonToTemp = jasmine.createSpy('metadata').and.resolveTo(true);
    service.getPackageJson = jasmine.createSpy('manifest').and.resolveTo({ name: 'original' });
    return { service, dispatch };
  }
  for (const stage of ['dispatch', 'metadata', 'manifest']) it(`settles after ${stage} rejection instead of hanging`, async () => {
    const { service, dispatch } = fixture();
    const operation = stage === 'dispatch' ? dispatch : stage === 'metadata' ? service.copyPackageJsonToTemp : service.getPackageJson;
    operation.and.rejectWith(new Error(`${stage} unavailable`));
    expect(await service.save()).toEqual({ success: false, error: `${stage} unavailable`, path: '/original' });
    expect(service.stateSubject.value).toBe('error');
  });
  it('requires an explicit successful acknowledgement', async () => {
    const { service, dispatch } = fixture();
    for (const reply of [undefined, { success: false, error: 'not committed' }, { success: 'true' }]) {
      dispatch.and.resolveTo(reply); expect((await service.save()).success).toBeFalse();
    }
    expect(service.copyPackageJsonToTemp).not.toHaveBeenCalled();
  });
  for (const success of [true, false]) it(`does not publish stale save status after replacement (success=${success})`, async () => {
    const { service, dispatch } = fixture();
    dispatch.and.callFake(async () => {
      service.currentProjectPathSubject.next('/replacement'); service.stateSubject.next('loaded');
      return { success, error: success ? undefined : 'old error' };
    });
    expect((await service.save('/original')).success).toBe(success);
    expect(service.stateSubject.value).toBe('loaded'); expect(service.getPackageJson).not.toHaveBeenCalled();
  });
  it('does not publish stale metadata after reopening the same path', async () => {
    const { service, dispatch } = fixture();
    service.getProjectDependencySession('/original');
    dispatch.and.callFake(async () => {
      service.dependencyLifecycle.cancel('/original');
      await service.dependencyLifecycle.waitForIdle(service.dependencyLifecycle.get('/original'));
      service.dependencyLifecycle.release(service.dependencyLifecycle.get('/original'));
      service.getProjectDependencySession('/original'); service.stateSubject.next('loaded');
      return { success: true };
    });
    expect((await service.save()).success).toBeTrue();
    expect(service.stateSubject.value).toBe('loaded'); expect(service.getPackageJson).not.toHaveBeenCalled();
  });
});

describe('shared save-as menu', () => {
  for (const mode of ['blockly', 'coder']) it(`guards concurrent selection and reports failures for ${mode}`, async () => {
    const view: any = Object.create(HeaderComponent.prototype);
    let select: (path: string) => void;
    view.selectSaveAsFolder = jasmine.createSpy('folder').and.callFake(() => new Promise<string>(resolve => { select = resolve; }));
    view.projectService = projectFixture({ getProjectMode: () => mode,
      saveAs: jasmine.createSpy('saveAs').and.rejectWith(new Error('copy failed')) });
    view.message = { error: jasmine.createSpy('error') };
    const first = view.process({ action: 'project-save-as' });
    await view.process({ action: 'project-save-as' });
    expect(view.selectSaveAsFolder).toHaveBeenCalledTimes(1);
    view.projectService.currentProjectPath = '/replacement'; select!('/copy'); await first;
    expect(view.projectService.saveAs).not.toHaveBeenCalled(); expect(view.message.error).toHaveBeenCalled();
    const second = view.process({ action: 'project-save-as' }); select!('/copy'); await second;
    expect(view.projectService.saveAs).toHaveBeenCalledOnceWith('/copy');
    expect(view.message.error).toHaveBeenCalledWith('另存为失败：copy failed');
    expect(view.projectSavingAs).toBeFalse();
  });
  it('does not use an old destination choice for a reopened project at the same path', async () => {
    const view: any = Object.create(HeaderComponent.prototype);
    let select!: (path: string) => void;
    view.selectSaveAsFolder = () => new Promise<string>(resolve => { select = resolve; });
    view.projectService = projectFixture({ saveAs: jasmine.createSpy('saveAs') });
    view.message = { error: jasmine.createSpy('error') };
    const pending = view.process({ action: 'project-save-as' });
    replaceSession(view.projectService); select('/copy'); await pending;
    expect(view.projectService.saveAs).not.toHaveBeenCalled(); expect(view.message.error).toHaveBeenCalled();
  });
});

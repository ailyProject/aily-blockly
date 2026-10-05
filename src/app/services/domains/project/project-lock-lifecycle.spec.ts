import { fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';

describe('Project command lifecycle during close', () => {
  let original: any;
  let service: any;
  let order: string[];
  beforeEach(() => {
    original = { projectLock: window['projectLock'], ipcRenderer: window['ipcRenderer'], path: window['path'] };
    order = [];
    window['path'] = { resolve: (value: string) => value, normalize: (value: string) => value };
    window['projectLock'] = { release: jasmine.createSpy('release').and.callFake(async (path: string) => {
      order.push('release:' + path); return { ok: true };
    }) };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('invoke').and.callFake(async (channel: string, data: any) => {
      if (channel === 'project-commands-stop') order.push('stop:' + data.projectPath);
      return { ok: true };
    }) };
    service = Object.create(ProjectService.prototype);
    service.projectLifecycle = new ProjectLifecycleGate();
    service.currentProjectPathSubject = new BehaviorSubject('/active');
    service.coderProjectsSubject = new BehaviorSubject([]);
    service.coderWorkspaceSubject = new BehaviorSubject(null);
    service.coderOperationsSubject = new BehaviorSubject(new Map());
    service.coderProjectContexts = new Map();
    service.stateSubject = new BehaviorSubject('loaded');
    service.electronService = { isElectron: true };
    service.messageService = { warning: jasmine.createSpy('warning') };
    service.logService = { update: jasmine.createSpy('log') };
    service.translate = { instant: (key: string) => key };
    service.routerService = { navigate: jasmine.createSpy('navigate').and.callFake(async () => { order.push('navigate'); return true; }) };
    Object.defineProperty(service, 'application', { value: {
      hasActiveProjectMutation: () => false, closeConnectionGraphWindows: async () => true, closeTerminal() {},
    } });
    spyOn(service, 'getProjectMode').and.returnValue('blockly');
    spyOn(service, 'publishCoderWorkspaceContext');
    spyOn(service, 'publishCoderOperations');
    spyOn(service, 'publishCoderProjects');
    spyOn(service, 'storedCoderWorkspaceFor').and.returnValue(null);
  });
  afterEach(() => Object.assign(window, original));

  it('keeps project admission closed and waits for native commands before disposing the project', fakeAsync(() => {
    let finish!: (value: any) => void;
    window['ipcRenderer'].invoke.and.callFake((channel: string) => channel === 'project-commands-stop'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
    let result: boolean | undefined;
    service.close().then((value: boolean) => { result = value; });
    flushMicrotasks();
    expect(service.isProjectTransitionInProgress('/active')).toBeTrue();
    expect(service.currentProjectPath).toBe('/active');
    expect(window['projectLock'].release).not.toHaveBeenCalled();
    expect(service.routerService.navigate).not.toHaveBeenCalled();
    finish({ ok: true }); flushMicrotasks();
    expect(result).toBeTrue();
    expect(service.currentProjectPath).toBe('');
    expect(service.isProjectTransitionInProgress('/active')).toBeFalse();
    expect(order).toEqual(['release:/active', 'navigate']);
    expect(service.logService.update).not.toHaveBeenCalled();
  }));

  it('retains the project and rejects replacement until command stop is confirmed on retry', async () => {
    service.dependencyLifecycle.beginPreparation('/active');
    window['ipcRenderer'].invoke.and.resolveTo({ ok: false });
    expect(await service.close()).toBeFalse();
    expect(service.logService.update).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe('/active');
    expect(service.isProjectTransitionInProgress('/active')).toBeTrue();
    expect(window['projectLock'].release).not.toHaveBeenCalled();
    expect(service.routerService.navigate).not.toHaveBeenCalled();
    expect(await service.projectOpen('/next')).toBeFalse();
    window['ipcRenderer'].invoke.and.resolveTo({ ok: true });
    expect(await service.close()).toBeTrue();
    expect(service.isProjectTransitionInProgress('/active')).toBeFalse();
    expect(service.logService.update).toHaveBeenCalledOnceWith({
      title: 'PROJECT.DEPENDENCY_TASKS_STOPPED', detail: '/active', state: 'warn',
    });
  });

  it('stops each project once when closing the workspace', async () => {
    service.coderProjectsSubject.next([{ path: '/active' }, { path: '/tab' }]);
    expect(await service.close()).toBeTrue();
    expect(order.slice(0, 2)).toEqual(['stop:/active', 'stop:/tab']);
    expect(order.indexOf('release:/active')).toBeGreaterThan(order.indexOf('stop:/tab'));
  });

  it('keeps a retained Coder tab when its stop fails and only removes that tab on confirmed retry', async () => {
    const folder = { path: '/tab' };
    service.coderProjectsSubject.next([folder]);
    window['ipcRenderer'].invoke.and.resolveTo({ ok: false });
    await expectAsync(service.removeCoderProject('/tab')).toBeRejected();
    const calls = window['ipcRenderer'].invoke.calls.allArgs();
    expect(calls).toEqual([
      ['project-commands-stop', jasmine.objectContaining({ projectPath: '/tab', projectSessionId: jasmine.any(String) })],
    ]);
    expect(service.currentProjectPath).toBe('/active');
    expect(service.coderProjects).toEqual([folder]);
    expect(window['projectLock'].release).not.toHaveBeenCalled();
    window['ipcRenderer'].invoke.and.resolveTo({ ok: true });
    await service.removeCoderProject('/tab');
    expect(service.coderProjects).toEqual([]);
  });

  it('shares sessions with shallow Coder contexts while isolating each project', async () => {
    service.getProjectMode.and.returnValue('coder');
    service.electronService.readFile = () => '{}';
    window['path'].join = (...parts: string[]) => parts.join('/');
    const a = service.getCoderProjectContext('/a');
    const b = service.getCoderProjectContext('/b');
    const session = service.dependencyLifecycle.beginPreparation('/a');
    expect(a.getProjectDependencySession()).toBe(session);
    expect(a.isProjectDependencyPreparationInProgress()).toBeTrue();
    expect(b.isProjectDependencyPreparationInProgress()).toBeFalse();
    const retained = service.dependencyLifecycle.beginPreparation('/b');
    service.coderProjectsSubject.next([{ path: '/a' }, { path: '/b' }]);
    await service.removeCoderProject('/a');
    expect(session.signal.aborted).toBeTrue();
    expect(retained.signal.aborted).toBeFalse();
    expect(b.isProjectDependencyPreparationInProgress()).toBeTrue();
    expect(order).toEqual(['stop:/a', 'release:/a']);
  });

  it('still stops dependency work when a child window prevents final disposal', async () => {
    service.application.closeConnectionGraphWindows = async () => false;
    spyOn(service, 'warnConnectionGraphWindowCloseFailure');
    const session = service.getProjectDependencySession('/active');
    expect(await service.close()).toBeFalse();
    expect(session.signal.aborted).toBeTrue();
    expect(order).toEqual(['stop:/active']);
    expect(service.currentProjectPath).toBe('/active');
    expect(window['projectLock'].release).not.toHaveBeenCalled();
  });

  it('aborts renderer work immediately but keeps the project until its asynchronous tail settles', fakeAsync(() => {
    const session = service.getProjectDependencySession('/active');
    let finish!: () => void;
    let cancelled: unknown;
    service.runProjectDependencyTask(session, () => new Promise<void>(resolve => { finish = resolve; }))
      .catch((error: unknown) => { cancelled = error; });
    let result: boolean | undefined;
    service.close().then((value: boolean) => { result = value; });
    flushMicrotasks();
    expect(session.signal.aborted).toBeTrue();
    expect(result).toBeUndefined();
    expect(window['projectLock'].release).not.toHaveBeenCalled();
    expect(service.logService.update).not.toHaveBeenCalled();
    finish(); flushMicrotasks();
    expect(cancelled).toEqual(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(result).toBeTrue();
    expect(service.logService.update).toHaveBeenCalledOnceWith({
      title: 'PROJECT.DEPENDENCY_TASKS_STOPPED', detail: '/active', state: 'warn',
    });
    const reopened = service.getProjectDependencySession('/active');
    expect(reopened.projectSessionId).not.toBe(session.projectSessionId);
  }));

  it('cancels editor preparation while projectOpen is still waiting for loaded', fakeAsync(() => {
    spyOn(service, 'getBlocklyProjectLoadStatus').and.returnValue({ ready: false });
    spyOn(service, 'projectOpenInternal').and.callFake(() => {
      const session = service.dependencyLifecycle.beginPreparation('/active');
      return service.waitForProjectOpenCompletion('/active', session).then(() => true);
    });
    let opened: boolean | undefined;
    let closed: boolean | undefined;
    service.projectOpen('/active').then((result: boolean) => { opened = result; });
    flushMicrotasks();
    expect(service.isProjectDependencyPreparationInProgress('/active')).toBeTrue();
    service.close().then((result: boolean) => { closed = result; });
    flushMicrotasks();
    expect(opened).toBeFalse();
    expect(closed).toBeTrue();
    expect(service.currentProjectPath).toBe('');
  }));
});

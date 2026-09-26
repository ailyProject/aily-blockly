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
  }));

  it('allows project close when command stop fails', async () => {
    window['ipcRenderer'].invoke.and.resolveTo({ ok: false });
    expect(await service.close()).toBeTrue();
    expect(service.currentProjectPath).toBe('');
    expect(service.isProjectTransitionInProgress('/active')).toBeFalse();
  });

  it('stops each project once when closing the workspace', async () => {
    service.coderProjectsSubject.next([{ path: '/active' }, { path: '/tab' }]);
    expect(await service.close()).toBeTrue();
    expect(order.slice(0, 2)).toEqual(['stop:/active', 'stop:/tab']);
    expect(order.indexOf('release:/active')).toBeGreaterThan(order.indexOf('stop:/tab'));
  });

  it('removing a retained Coder tab only stops that tab and stop failure does not prevent removal', async () => {
    const folder = { path: '/tab' };
    service.coderProjectsSubject.next([folder]);
    window['ipcRenderer'].invoke.and.resolveTo({ ok: false });
    await service.removeCoderProject('/tab');
    const calls = window['ipcRenderer'].invoke.calls.allArgs();
    expect(calls).toEqual([
      ['project-commands-stop', { projectPath: '/tab' }],
    ]);
    expect(service.currentProjectPath).toBe('/active');
    expect(service.coderProjects).toEqual([]);
  });
});

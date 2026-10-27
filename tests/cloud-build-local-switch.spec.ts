import { Subject } from 'rxjs';
import { withLocalBuildSwitch, CLOUD_BUILD_CLOUD_REQUESTED } from '../src/app/utils/local-build-switch.utils';
import { CLOUD_BUILD_LOCAL_REQUESTED, runCloudBuildWithProgress } from '../src/app/utils/cloud-build-progress.utils';
import { ProjectService } from '../src/app/services/domains/project/project.service';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('switching a running cloud build to local', () => {
  async function fixture() {
    const run = deferred<any>(), cancel = deferred<any>(), started = deferred<void>();
    let requestSwitch!: () => boolean, listener!: (event: any) => void, current = true;
    const log = jasmine.createSpy('log'), progress = jasmine.createSpy('progress'), unsubscribe = jasmine.createSpy('unsubscribe');
    const bridge = { run: jasmine.createSpy('run').and.callFake(() => { started.resolve(); return run.promise; }),
      cancel: jasmine.createSpy('cancel').and.returnValue(cancel.promise),
      onProgress: (callback: any) => { listener = callback; return unsubscribe; } };
    let settled = false;
    const result = runCloudBuildWithProgress({ requestId: 'owned' }, bridge, {
      isCurrent: () => current, log, progress, localSwitch: action => { requestSwitch = action; },
    }).then(value => value, error => error).finally(() => { settled = true; });
    // Exercise a submitted build, after the asynchronous resource preflight.
    await started.promise;
    return { run, cancel, bridge, result, log, progress, unsubscribe,
      switch: () => requestSwitch(), emit: (event: any) => listener(event),
      invalidate: () => { current = false; }, settled: () => settled };
  }

  for (const first of ['run', 'cancel'] as const) it(`waits for both cloud completion and cancellation when ${first} finishes first`, async () => {
    const f = await fixture();
    expect(f.switch()).toBeTrue(); expect(f.switch()).toBeFalse();
    await Promise.resolve();
    expect(f.bridge.cancel).toHaveBeenCalledOnceWith({ requestId: 'owned' });
    f[first].resolve(first === 'run' ? { success: true } : true);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(f.settled()).toBeFalse();
    f[first === 'run' ? 'cancel' : 'run'].resolve({ success: true });
    expect((await f.result).code).toBe(CLOUD_BUILD_LOCAL_REQUESTED);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.switch()).toBeFalse();
  });

  it('discards late cloud notices and compiler logs after the user switches', async () => {
    const f = await fixture(); f.switch();
    f.emit({ requestId: 'owned', stage: 'compiling', progress: 90, log: 'cancelled cloud output' });
    f.run.reject({ code: 'CANCELLED', message: 'aborted' }); f.cancel.resolve(true);
    expect((await f.result).code).toBe(CLOUD_BUILD_LOCAL_REQUESTED);
    expect(f.log).not.toHaveBeenCalled(); expect(f.progress).not.toHaveBeenCalled();
  });

  it('does not start local compilation if Stop, settings or project changes invalidate the task', async () => {
    const f = await fixture(); f.switch(); f.invalidate();
    f.run.reject({ code: 'CANCELLED', message: 'aborted' }); f.cancel.resolve(true);
    expect((await f.result).code).toBe('CANCELLED');
  });

  it('does not start local compilation if cancellation fails', async () => {
    const f = await fixture(); f.switch();
    f.cancel.reject(new Error('IPC disconnected')); f.run.resolve({ success: true });
    expect((await f.result).message).toBe('IPC disconnected');
  });

  it('ignores a stale button after completion or project invalidation', async () => {
    const f = await fixture(); f.run.resolve({ success: true });
    expect((await f.result).success).toBeTrue(); expect(f.switch()).toBeFalse();
    expect(f.bridge.cancel).not.toHaveBeenCalled();
    const other = await fixture(); other.invalidate(); expect(other.switch()).toBeFalse();
    other.run.resolve({ success: true }); await other.result;
    expect(other.bridge.cancel).not.toHaveBeenCalled();
  });
});

describe('switching before the cloud request is submitted', () => {
  for (const invalidated of [false, true]) it(`waits for resource preflight without submitting a cloud build (invalidated=${invalidated})`, async () => {
    const requirements = deferred<[]>(), cancelled = deferred<boolean>();
    let current = true, settled = false, requestSwitch!: () => boolean;
    const unsubscribe = jasmine.createSpy('unsubscribe');
    const bridge = {
      preparationRequirements: () => requirements.promise,
      run: jasmine.createSpy('run').and.resolveTo({ success: true }),
      cancel: jasmine.createSpy('cancel').and.returnValue(cancelled.promise),
      onProgress: () => unsubscribe,
    };
    const result = runCloudBuildWithProgress({ requestId: 'preparing' }, bridge, {
      isCurrent: () => current, log: () => {}, progress: () => {}, localSwitch: action => { requestSwitch = action; },
    }).then(value => value, error => error).finally(() => { settled = true; });
    expect(requestSwitch()).toBeTrue();
    if (invalidated) current = false;
    cancelled.resolve(true);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(settled).toBeFalse();
    expect(bridge.run).not.toHaveBeenCalled();
    requirements.resolve([]);
    expect((await result).code).toBe(invalidated ? 'BUILD_SOURCE_STALE' : CLOUD_BUILD_LOCAL_REQUESTED);
    expect(bridge.run).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalledOnceWith({ requestId: 'preparing' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(requestSwitch()).toBeFalse();
  });
});

describe('task-local compile backend lifetime', () => {
  let project: any, settings: string;
  beforeEach(() => {
    settings = 'cloud-cn-pro';
    project = Object.assign(Object.create(ProjectService.prototype), {
      currentProjectPathSubject: { value: '/project' },
      configService: { getCompileBackend: () => 'cloud', getCompileSettingsKey: () => settings },
    });
  });

  it('keeps the upload local after its nested compiler finishes, then restores cloud', async () => {
    const upload = project.beginBuildBackendOperation(), compile = project.beginBuildBackendOperation();
    compile.useLocal(); compile.release(); compile.release();
    expect(upload.local).toBeTrue(); expect(project.isCloudBuild()).toBeFalse();
    expect(await project.resolveCompileBackend()).toBe('local');
    expect(project.isCloudBuild('/other')).toBeTrue();
    upload.release();
    expect(project.isCloudBuild()).toBeTrue();
    const next = project.beginBuildBackendOperation(); expect(next.local).toBeFalse(); next.release();
  });

  it('shares repeated changes with the upload owner without changing the saved preference', () => {
    const upload = project.beginBuildBackendOperation(), build = project.beginBuildBackendOperation();
    build.useLocal(); expect(upload.local).toBeTrue();
    build.useCloud(); expect(upload.local).toBeFalse(); expect(project.isCloudBuild()).toBeTrue();
    build.useLocal(); build.release(); expect(upload.local).toBeTrue();
    upload.useCloud(); upload.release(); expect(project.isCloudBuild()).toBeTrue();
    expect(settings).toBe('cloud-cn-pro'); expect(() => build.useCloud()).toThrow();
  });

  it('rejects cloud reentry after entitlement is revoked', () => {
    const build = project.beginBuildBackendOperation(); build.useLocal();
    project.configService.getCompileBackend = () => 'local';
    expect(() => build.useCloud()).toThrow(); build.release();
  });

  it('does not carry a local override into a replacement dependency session', () => {
    const old = project.beginBuildBackendOperation(); old.useLocal();
    settings = 'cloud-other-settings';
    expect(project.isCloudBuild()).toBeTrue();
    expect(() => old.useLocal()).toThrow();
    const next = project.beginBuildBackendOperation(); next.useLocal();
    old.release(); expect(project.isCloudBuild()).toBeFalse();
    next.release(); expect(project.isCloudBuild()).toBeTrue();
  });
});


describe('returning a local attempt to the cloud', () => {
  function fixture() {
    const source = new Subject<any>(), stopped = deferred<boolean>();
    let action: (() => boolean) | undefined, current = true;
    const events: any[] = [], fail = jasmine.createSpy('fail'), complete = jasmine.createSpy('complete');
    const stop = jasmine.createSpy('stop').and.returnValue(stopped.promise);
    const subscription = withLocalBuildSwitch(source, { isCurrent: () => current, stop,
      ready: value => { action = value; }, switching: () => {},
    }).subscribe({ next: event => events.push(event), error: fail, complete });
    return { source, stopped, stop, fail, complete, subscription, events,
      action: () => action?.(), invalidate: () => { current = false; } };
  }

  it('registers only after launch and waits for process-tree cancellation while discarding late output', async () => {
    const f = fixture(); expect(f.action()).toBeUndefined();
    f.source.next({ type: 'stdout', data: 'started' });
    expect(f.action()).toBeTrue(); expect(f.action()).toBeFalse();
    f.source.next({ type: 'stdout', data: 'late' }); f.source.complete();
    await Promise.resolve(); expect(f.fail).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    f.stopped.resolve(true); for (let n = 0; n < 4; n++) await Promise.resolve();
    expect(f.fail).toHaveBeenCalledOnceWith(jasmine.objectContaining({ code: CLOUD_BUILD_CLOUD_REQUESTED }));
    expect(f.events.length).toBe(1); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.action()).toBeFalse();
  });

  it('keeps ownership after a failed kill until the local process really exits', async () => {
    const f = fixture(); f.source.next({ type: 'stdout' }); f.action(); f.stopped.resolve(false);
    for (let n = 0; n < 4; n++) await Promise.resolve();
    expect(f.fail).not.toHaveBeenCalled();
    f.source.complete(); for (let n = 0; n < 4; n++) await Promise.resolve();
    expect(f.fail).toHaveBeenCalledOnceWith(jasmine.objectContaining({ message: 'Local compiler did not confirm cancellation.' }));
  });

  it('does not return to cloud after Stop or an invalidated project', async () => {
    const f = fixture(); f.source.next({ type: 'stdout' }); f.action(); f.invalidate(); f.stopped.resolve(true);
    for (let n = 0; n < 4; n++) await Promise.resolve();
    expect(f.fail).toHaveBeenCalledOnceWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    const stopped = fixture(); stopped.source.next({ type: 'stdout' }); stopped.action(); stopped.subscription.unsubscribe();
    stopped.stopped.resolve(true); for (let n = 0; n < 4; n++) await Promise.resolve();
    expect(stopped.fail).not.toHaveBeenCalled();
  });

  it('does not act on a button left behind after normal completion', () => {
    const f = fixture(); f.source.next({ type: 'stdout' }); f.source.complete();
    expect(f.action()).toBeFalse(); expect(f.stop).not.toHaveBeenCalled(); expect(f.complete).toHaveBeenCalledTimes(1);
  });
});

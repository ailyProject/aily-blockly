import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('live build receipt ownership', () => {
  function fixture() {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    const events: boolean[] = [];
    let finish!: (result: Record<string, any>) => void;
    const build = new Promise<Record<string, any>>(resolve => { finish = resolve; });
    Object.assign(service, {
      mutationSequence: 0,
      projectService: { currentProjectPath: '/isolated', isProjectTransitionInProgress: () => false },
      aiOperations: { setActive: (_id: string, active: boolean) => events.push(active) },
      executeOperation: jasmine.createSpy('build').and.returnValue(build),
    });
    const request = (operation = 'project_build', extra = {}) => ({ operation, path: '/isolated',
      params: { buildRequest: { version: 1, requestId: 'isolated-build', waitMs: 10 }, ...extra } });
    return { service, events, finish, request };
  }

  it('returns running after the observation budget without releasing the actual build', fakeAsync(() => {
    const f = fixture(), answer = jasmine.createSpy('answer');
    f.service.execute(f.request()).then(answer); flushMicrotasks(); tick(11);
    expect(answer).toHaveBeenCalledWith(jasmine.objectContaining({
      ok: true, buildReceipt: jasmine.objectContaining({ state: 'running', requestId: 'isolated-build' }),
    }));
    expect(f.events).toEqual([true]);
    f.finish({ ok: true, operation: 'project_build', project: '/isolated' }); flushMicrotasks();
    expect(f.events).toEqual([true, false]);
  }));

  it('reads the terminal result of that exact build and does not start another compile', fakeAsync(() => {
    const f = fixture(), initial = jasmine.createSpy('initial'), status = jasmine.createSpy('status');
    f.service.execute(f.request()).then(initial); flushMicrotasks(); tick(11);
    f.finish({ ok: false, operation: 'project_build', message: 'real compiler failure' }); flushMicrotasks();
    f.service.execute(f.request('project_build_status')).then(status); flushMicrotasks();
    expect(status).toHaveBeenCalledWith(jasmine.objectContaining({
      ok: true, buildReceipt: jasmine.objectContaining({ state: 'completed' }),
      result: jasmine.objectContaining({ ok: false, message: 'real compiler failure' }),
    }));
    expect(f.service.executeOperation).toHaveBeenCalledTimes(1);
  }));

  it('keeps status reachable while workspace gates are busy and never registers it as a mutation', fakeAsync(() => {
    const f = fixture(), status = jasmine.createSpy('status');
    void f.service.execute(f.request()); flushMicrotasks(); tick(11);
    f.service.absApplyInProgress = true;
    f.service.boardSwitchInProgress = true;
    f.service.projectService.isProjectTransitionInProgress = () => true;
    f.service.execute(f.request('project_build_status')).then(status); flushMicrotasks(); tick(11);
    expect(status).toHaveBeenCalledWith(jasmine.objectContaining({ buildReceipt: jasmine.objectContaining({ state: 'running' }) }));
    expect(f.events).toEqual([true]);
    expect(f.service.executeOperation).toHaveBeenCalledTimes(1);
    f.finish({ ok: true }); flushMicrotasks();
    expect(f.events).toEqual([true, false]);
  }));

  it('keeps legacy builds synchronous and does not wrap their existing response', fakeAsync(() => {
    const f = fixture(), result = jasmine.createSpy('result');
    f.service.execute({ operation: 'project_build', path: '/isolated', params: {} }).then(result);
    flushMicrotasks(); tick(20_000);
    expect(result).not.toHaveBeenCalled();
    f.finish({ ok: true, message: 'legacy completed' }); flushMicrotasks();
    expect(result).toHaveBeenCalledOnceWith({ ok: true, message: 'legacy completed' });
    expect(f.events).toEqual([true, false]);
  }));

  it('does not start a build when receipt validation or project admission rejects it', fakeAsync(() => {
    const f = fixture(), invalid = jasmine.createSpy('invalid'), rejected = jasmine.createSpy('rejected');
    f.service.execute({ ...f.request(), params: { buildRequest: { version: 1, requestId: 'bad/id' } } }).then(invalid);
    flushMicrotasks();
    expect(invalid).toHaveBeenCalledWith(jasmine.objectContaining({ ok: false, code: 'BUILD_RECEIPT_INVALID' }));
    f.service.projectService.isProjectTransitionInProgress = () => true;
    f.service.execute(f.request()).then(rejected); flushMicrotasks(); tick(11);
    expect(rejected).toHaveBeenCalledWith(jasmine.objectContaining({
      buildReceipt: jasmine.objectContaining({ state: 'completed' }),
      result: jasmine.objectContaining({ ok: false, reason: 'project_lifecycle_busy', buildOutcome: 'not-started' }),
    }));
    expect(f.service.executeOperation).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  }));

  for (const gate of ['boardSwitchInProgress', 'absApplyInProgress']) {
    it(`marks ${gate} admission as not-started without weakening the gate`, async () => {
      const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
      service[gate] = true;
      expect(await service.executeOperation({ operation: 'project_build' }))
        .toEqual(jasmine.objectContaining({ ok: false, buildOutcome: 'not-started' }));
    });
  }

  it('marks library readiness failures as not-started rather than compiler failures', async () => {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.projectService = { currentProjectPath: '/isolated', ensureBlocklyLibraryRuntimeReady: async () => { throw new Error('runtime not ready'); } };
    expect(await service.executeProjectBuild({})).toEqual(jasmine.objectContaining({
      ok: false, buildOutcome: 'not-started', message: 'runtime not ready',
    }));
  });
});

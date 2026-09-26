import { ProjectDependencyLifecycle } from './project-dependency-lifecycle';

describe('project dependency session lifecycle', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('holds preparation across nested work and allows a later retry in the same session', async () => {
    const lifecycle = new ProjectDependencyLifecycle();
    const session = lifecycle.beginPreparation('/project');
    const first = deferred(), second = deferred();
    let started = false;
    const work = lifecycle.run(session, async () => {
      started = true;
      await lifecycle.run(session, () => first.promise);
      await second.promise;
    });
    expect(started).toBeTrue();
    lifecycle.finishPreparation(session);
    expect(lifecycle.isBusy('/project')).toBeTrue();
    first.resolve(); await first.promise;
    expect(lifecycle.isBusy('/project')).toBeTrue();
    second.resolve(); await work;
    expect(lifecycle.isBusy('/project')).toBeFalse();
    expect(lifecycle.ensure('/project')).toBe(session);
    await lifecycle.run(session, async () => expect(lifecycle.isBusy('/project')).toBeTrue());
    expect(lifecycle.isBusy('/project')).toBeFalse();
  });

  it('waits for cancelled work to settle and keeps stopping until explicit release', async () => {
    const lifecycle = new ProjectDependencyLifecycle();
    const session = lifecycle.beginPreparation('/project');
    const deferredWork = deferred();
    const work = lifecycle.run(session, () => deferredWork.promise);
    const rejected = expectAsync(work).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(lifecycle.cancel('/project')).toBe(session);
    expect(session.signal.aborted).toBeTrue();
    expect(lifecycle.isStopping('/project')).toBeTrue();
    expect(() => lifecycle.ensure('/project')).toThrow();
    const next = jasmine.createSpy('next');
    await expectAsync(lifecycle.run(session, next)).toBeRejected();
    expect(next).not.toHaveBeenCalled();
    let idle = false;
    const waiting = lifecycle.waitForIdle(session).then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBeFalse();
    deferredWork.resolve();
    await rejected; await waiting;
    expect(lifecycle.isBusy('/project')).toBeTrue();
    lifecycle.release(session);
    expect(lifecycle.isBusy('/project')).toBeFalse();
  });

  it('does not let late cleanup release a new session or another project', async () => {
    const lifecycle = new ProjectDependencyLifecycle();
    const old = lifecycle.beginPreparation('/project');
    lifecycle.cancel('/project');
    await lifecycle.waitForIdle(old);
    lifecycle.release(old);
    const current = lifecycle.beginPreparation('/project');
    const other = lifecycle.beginPreparation('/other');
    expect(current.projectSessionId).not.toBe(old.projectSessionId);
    lifecycle.finishPreparation(old);
    lifecycle.release(old);
    expect(lifecycle.get('/project')).toBe(current);
    expect(lifecycle.isBusy('/project')).toBeTrue();
    expect(lifecycle.get('/other')).toBe(other);
    expect(other.signal.aborted).toBeFalse();
    expect(() => lifecycle.assertCurrent(old)).toThrow();
  });

  it('reports cancellation when an aborted wait rejects with its own error', async () => {
    const lifecycle = new ProjectDependencyLifecycle();
    const session = lifecycle.ensure('/project');
    const work = lifecycle.run(session, async () => {
      lifecycle.cancel('/project');
      throw new Error('workspace wait ended');
    });
    await expectAsync(work).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    await lifecycle.waitForIdle(session);
  });

  it('cleans up rejected work, publishes changes and uses the supplied path identity', async () => {
    const lifecycle = new ProjectDependencyLifecycle(path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
    const changes = jasmine.createSpy('changes');
    const subscription = lifecycle.changes.subscribe(changes);
    const session = lifecycle.ensure('C:\\Project');
    expect(lifecycle.ensure('c:/project/')).toBe(session);
    expect(lifecycle.isBusy('c:/project')).toBeFalse();
    await expectAsync(lifecycle.run(session, () => { throw new Error('install failed'); })).toBeRejectedWithError('install failed');
    expect(lifecycle.isBusy('c:/project')).toBeFalse();
    await lifecycle.waitForIdle(session);
    expect(changes).toHaveBeenCalled();
    subscription.unsubscribe();
    const caseSensitive = new ProjectDependencyLifecycle();
    expect(caseSensitive.ensure('/Project')).not.toBe(caseSensitive.ensure('/project'));
  });
});

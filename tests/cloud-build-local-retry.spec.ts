import { createCloudBuildLocalRetry } from '../src/app/utils/cloud-build-local-retry.utils';

describe('explicit cloud error local retry', () => {
  it('waits for failed task cleanup and consumes duplicate clicks only once', async () => {
    let clean!: () => void;
    const retry = jasmine.createSpy('retry').and.resolveTo();
    const click = createCloudBuildLocalRetry({ settled: new Promise<void>(resolve => { clean = resolve; }),
      isCurrent: () => true, canStart: () => true, retry });
    expect(retry).not.toHaveBeenCalled();
    const first = click(), duplicate = click();
    expect(retry).not.toHaveBeenCalled();
    clean(); await Promise.all([first, duplicate]);
    await click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
  for (const reason of ['project', 'settings', 'new-task', 'busy']) it(`rejects a stale click after cleanup: ${reason}`, async () => {
    let clean!: () => void, current = true, ready = true;
    const retry = jasmine.createSpy('retry').and.resolveTo();
    const click = createCloudBuildLocalRetry({ settled: new Promise<void>(resolve => { clean = resolve; }),
      isCurrent: () => current, canStart: () => ready, retry });
    const pending = click();
    if (reason === 'busy') ready = false; else current = false;
    clean(); await pending;
    expect(retry).not.toHaveBeenCalled();
  });
  it('does not repeat a failed local compilation', async () => {
    const retry = jasmine.createSpy('retry').and.rejectWith(new Error('compiler error'));
    const click = createCloudBuildLocalRetry({ settled: Promise.resolve(), isCurrent: () => true, canStart: () => true, retry });
    await click(); await click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

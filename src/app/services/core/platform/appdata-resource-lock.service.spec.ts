import { AppDataResourceLockService } from './appdata-resource-lock.service';

describe('AppData resource lease boundary', () => {
  let original: any;
  let invoke: jasmine.Spy;
  let service: AppDataResourceLockService;
  beforeEach(() => {
    original = window['ipcRenderer'];
    invoke = jasmine.createSpy('invoke').and.callFake(async (channel: string) => channel.endsWith('acquire')
      ? { ok: true, token: 'reader', commandHandoff: true, writerCommandHandoff: true } : { ok: true });
    window['ipcRenderer'] = { invoke }; service = new AppDataResourceLockService();
  });
  afterEach(() => { window['ipcRenderer'] = original; });

  it('passes the native token and releases after the entire task, including failure', async () => {
    await expectAsync(service.runShared('build', async token => {
      expect(token).toBe('reader');
      expect(invoke.calls.allArgs().some(([name]) => name.endsWith('-release'))).toBeFalse();
      throw new Error('task failed');
    })).toBeRejectedWithError('task failed');
    expect(invoke).toHaveBeenCalledWith('appdata-resource-lock-release', { token: 'reader' });
  });

  it('cancels the pending request without releasing another scope', async () => {
    let resolve!: (value: any) => void;
    const controller = new AbortController(), task = jasmine.createSpy('task');
    invoke.and.callFake((channel: string) => channel.endsWith('acquire')
      ? new Promise(r => { resolve = r; }) : Promise.resolve({ ok: true }));
    const pending = service.runShared('build', task, controller.signal);
    const request = invoke.calls.allArgs().find(([name]) => name.endsWith('acquire'))![1];
    controller.abort();
    expect(invoke).toHaveBeenCalledWith('appdata-resource-lock-cancel', { requestId: request.requestId });
    resolve({ ok: false, error: 'APPDATA_RESOURCE_LOCK_CANCELLED' });
    await expectAsync(pending).toBeRejectedWithError('APPDATA_RESOURCE_LOCK_CANCELLED');
    expect(task).not.toHaveBeenCalled();
  });

  it('returns a raced grant without running a cancelled task', async () => {
    const controller = new AbortController(), task = jasmine.createSpy('task');
    const pending = service.runShared('build', task, controller.signal); controller.abort();
    await expectAsync(pending).toBeRejectedWithError('APPDATA_RESOURCE_LOCK_CANCELLED');
    expect(task).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('appdata-resource-lock-release', { token: 'reader' });
  });

  it('rejects an old host after returning its granted lock', async () => {
    invoke.and.callFake(async () => ({ ok: true, token: 'old-reader' }));
    await expectAsync(service.runShared('build', () => fail('must not run'))).toBeRejectedWithError(/Restart/);
    expect(invoke).toHaveBeenCalledWith('appdata-resource-lock-release', { token: 'old-reader' });
  });

  it('does not silently run without a native lock bridge', async () => {
    window['ipcRenderer'] = undefined;
    await expectAsync(service.runShared('build', () => fail('must not run'))).toBeRejectedWithError(/UNAVAILABLE/);
  });

  it('hands off the writer token and requires writer-capable main', async () => {
    await service.runExclusive('install', token => expect(token).toBe('reader'));
    invoke.and.callFake(async () => ({ ok: true, token: 'old-writer', commandHandoff: true }));
    await expectAsync(service.runExclusive('install', () => fail('must not run'))).toBeRejectedWithError(/Restart/);
    expect(invoke).toHaveBeenCalledWith('appdata-resource-lock-release', { token: 'old-writer' });
  });

  it('cancels a queued writer promptly without letting the next writer overtake the active task', async () => {
    let finish!: () => void;
    const first = service.runExclusive('first', () => new Promise<void>(resolve => { finish = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const controller = new AbortController(), cancelled = jasmine.createSpy('cancelled'), last = jasmine.createSpy('last');
    const pending = service.runExclusive('cancelled', cancelled, controller.signal);
    const next = service.runExclusive('last', last);
    controller.abort();
    await expectAsync(pending).toBeRejectedWithError('APPDATA_RESOURCE_LOCK_CANCELLED');
    expect(cancelled).not.toHaveBeenCalled(); expect(last).not.toHaveBeenCalled();
    expect(invoke.calls.allArgs().filter(([name]) => name.endsWith('-acquire')).length).toBe(1);
    finish(); await first; await next;
    expect(last).toHaveBeenCalledTimes(1);
  });
});

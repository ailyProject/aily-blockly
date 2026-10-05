import { CmdService } from './cmd.service';

describe('CmdService command lifecycle', () => {
  let oldCmd: any;
  beforeEach(() => { oldCmd = window['cmd']; });
  afterEach(() => { window['cmd'] = oldCmd; });

  it('still requests main-process cleanup after the output stream closes', async () => {
    let listener!: (event: any) => void;
    const kill = jasmine.createSpy('kill').and.resolveTo({ success: false });
    window['cmd'] = {
      run: async () => ({ success: true }), kill,
      onData: (_id: string, fn: (event: any) => void) => { listener = fn; return () => {}; },
    };
    const service = new CmdService({ update() {} } as any);
    service.spawn('node', [], { streamId: 'preprocess' }).subscribe();
    listener({ type: 'close', streamId: 'preprocess', code: 1 });

    expect(await service.kill('preprocess')).toBeFalse();
    kill.and.resolveTo({ success: true });
    expect(await service.kill('preprocess')).toBeTrue();
    expect(kill.calls.allArgs()).toEqual([['preprocess'], ['preprocess']]);
  });

  for (const queued of [true, false]) it(`executes ${queued ? 'queued' : 'direct'} checked commands`, async () => {
    const listeners = new Map<string, (event: any) => void>();
    const run = jasmine.createSpy('run').and.callFake(async (options: any) => {
      setTimeout(() => listeners.get(options.streamId)!({ type: 'close', streamId: options.streamId, code: 0 }), 0);
      return { success: true };
    });
    window['cmd'] = { run, onData: (id: string, listener: (event: any) => void) => {
      listeners.set(id, listener); return () => listeners.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    await service.runAsyncChecked('npm run postinstall', '/sdk', queued, false);
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      command: 'npm', args: ['run', 'postinstall'], cwd: '/sdk',
    }));
    expect(listeners.size).toBe(0);
  });

  it('preserves the exact build request and workspace on direct spawn', async () => {
    let listener: (event: any) => void;
    const run = jasmine.createSpy('run').and.callFake(async (options: any) => {
      setTimeout(() => listener({ type: 'close', streamId: options.streamId, code: 0 }), 0);
      return { success: true, buildDeliveryHandle: 'host-handle' };
    });
    window['cmd'] = { run, onData: (_id: string, fn: (event: any) => void) => { listener = fn; return () => {}; } };
    const service = new CmdService({ update() {} } as any);
    const request = '/project/.temp/compile-request.json';
    await new Promise<void>((resolve, reject) => service.spawn('node', ['/child/compile.js', request], {
      buildWorkspace: '/project', buildDeliveryRequest: request, shellProfile: false,
    }).subscribe({ error: reject, complete: resolve }));
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      buildDeliveryRequest: request, buildWorkspace: '/project', shellProfile: false,
    }));
  });

  it('removes a cancelled queued project command without spawning it or dropping another project', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const run = jasmine.createSpy('run').and.resolveTo({ success: true });
    window['cmd'] = { run, onData: (id: string, listener: (event: any) => void) => {
      listeners.set(id, listener); return () => listeners.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    const blocker = service.runAsync('node blocker', '/other', true, true, { streamId: 'blocker' });
    const controller = new AbortController();
    const cancelled = service.runAsyncChecked('npm install', '/project', true, false, {
      projectPath: '/project', projectSessionId: 'opening-1', signal: controller.signal,
    });
    const rejected = expectAsync(cancelled).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_COMMAND_CANCELLED' }));
    const other = service.runAsyncChecked('npm install', '/other', true, true, {
      streamId: 'other', projectPath: '/other', projectSessionId: 'opening-2',
    });
    expect(service.getQueueLength()).toBe(2);
    controller.abort();
    await rejected;
    expect(service.getQueueLength()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    listeners.get('blocker')!({ type: 'close', streamId: 'blocker', code: 0 });
    await blocker;
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      projectPath: '/other', projectSessionId: 'opening-2',
    }));
    listeners.get('other')!({ type: 'close', streamId: 'other', code: 0 });
    await other;
    expect(listeners.size).toBe(0);
  });

  it('strips the signal from IPC and suppresses late output after cancelling an active command', async () => {
    let listener!: (event: any) => void;
    const removeListener = jasmine.createSpy('removeListener');
    const run = jasmine.createSpy('run').and.resolveTo({ success: true });
    window['cmd'] = { run, onData: (_id: string, callback: (event: any) => void) => {
      listener = callback; return removeListener;
    } };
    const log = { update: jasmine.createSpy('log') };
    const service = new CmdService(log as any);
    const controller = new AbortController();
    const pending = service.runAsyncChecked('npm run postinstall', '/package', false, true, {
      streamId: 'install', projectPath: '/project', projectSessionId: 'opening', signal: controller.signal,
    });
    const rejected = expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_COMMAND_CANCELLED' }));
    const options = run.calls.mostRecent().args[0];
    expect(options.projectPath).toBe('/project');
    expect(options.projectSessionId).toBe('opening');
    expect('signal' in options).toBeFalse();
    controller.abort();
    await rejected;
    listener({ type: 'stderr', streamId: 'install', data: 'late failure' });
    listener({ type: 'close', streamId: 'install', code: 1 });
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(log.update).not.toHaveBeenCalled();
    await expectAsync(service.runAsyncChecked('npm install', '/project', true, false, {
      signal: controller.signal,
    })).toBeRejected();
    await expectAsync(service.runAsyncChecked('npm install', '/project', false, false, {
      signal: controller.signal,
    })).toBeRejected();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

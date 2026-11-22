import { CmdService } from './cmd.service';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';

describe('CmdService command lifecycle', () => {
  let oldCmd: any;
  beforeEach(() => { oldCmd = window['cmd']; });
  afterEach(() => { window['cmd'] = oldCmd; });

  it('recovers a missing close for the original Blockly stream once', fakeAsync(() => {
    const callbacks = new Map<string, (event: any) => void>();
    const observer = jasmine.createSpy('close');
    const status = jasmine.createSpy('status').and.resolveTo({
      streamId: 'other', state: 'exited', code: 0, terminationConfirmed: true, ownershipReleased: true
    });
    const run = jasmine.createSpy('run').and.resolveTo({ success: true });
    window['cmd'] = { run, status, onData: (id: string, fn: (event: any) => void) => {
      callbacks.set(id, fn); return () => callbacks.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    service.spawn('node', [], { streamId: 'original', buildWorkspace: '/captured', observeExit: true }).subscribe(observer);
    flushMicrotasks(); tick(500);
    expect(observer).not.toHaveBeenCalled();
    status.and.resolveTo({ streamId: 'original', state: 'exited', code: 0, terminationConfirmed: true, ownershipReleased: true });
    tick(500);
    expect(observer).toHaveBeenCalledOnceWith(jasmine.objectContaining({ type: 'close', streamId: 'original', recovered: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
  }));

  it('returns an unconfirmed stop instead of leaving a fenced foreground caller waiting for IPC', fakeAsync(() => {
    const kill = jasmine.createSpy('kill').and.returnValue(new Promise(() => {}));
    window['cmd'] = { kill };
    const service = new CmdService({ update() {} } as any);
    const result = jasmine.createSpy('result');
    void service.kill('original', 200).then(result);
    tick(200);
    expect(result).toHaveBeenCalledOnceWith(false);
    expect(kill).toHaveBeenCalledOnceWith('original');
  }));

  it('retains the exact host admission refusal through its original stream', fakeAsync(() => {
    const run = jasmine.createSpy('run').and.resolveTo({ success: false, streamId: 'original',
      error: 'The previous cache owner is unverified.', code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED', buildOutcome: 'not-started' });
    window['cmd'] = { run, onData: () => () => {} };
    const service = new CmdService({ update() {} } as any);
    const rejected = jasmine.createSpy('rejected');
    service.spawn('node', [], { streamId: 'original', buildWorkspace: '/captured' }).subscribe({ error: rejected });
    flushMicrotasks();
    expect(rejected).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED', buildOutcome: 'not-started',
    }));
    expect(run).toHaveBeenCalledTimes(1);
  }));

  it('settles a queued npm command by its own receipt and starts the next command once', fakeAsync(() => {
    const listeners = new Map<string, (data: any) => void>();
    const run = jasmine.createSpy('run').and.resolveTo({ success: true });
    const status = jasmine.createSpy('status').and.resolveTo({
      streamId: 'wrong', state: 'exited', code: 0, ownershipReleased: true
    });
    window['cmd'] = { run, status, onData: (id: string, fn: (event: any) => void) => {
      listeners.set(id, fn);
      return () => listeners.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    const first = jasmine.createSpy('first result');
    const next = jasmine.createSpy('next result');
    void service.runAsync('npm install', '/first', true, true, { streamId: 'first' }).then(first);
    void service.runAsync('npm install', '/next', true, true, { streamId: 'next' }).then(next);

    flushMicrotasks(); tick(500);
    expect(first).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    const lateClose = listeners.get('first')!;
    status.and.resolveTo({ streamId: 'first', state: 'exited', code: 0, ownershipReleased: true });
    tick(500);
    expect(first).toHaveBeenCalledOnceWith(jasmine.objectContaining({ streamId: 'first', code: 0, recovered: true }));
    expect(run.calls.allArgs().map(([options]) => options.streamId)).toEqual(['first', 'next']);
    lateClose({ type: 'close', streamId: 'first', code: 0 });
    expect(next).not.toHaveBeenCalled();
    listeners.get('next')!({ type: 'close', streamId: 'next', code: 0 });
    flushMicrotasks();
    expect(next).toHaveBeenCalledOnceWith(jasmine.objectContaining({ streamId: 'next', code: 0 }));
    expect(listeners.size).toBe(0);
  }));

  it('cancels only the exact dispatched queued command through its native owner', fakeAsync(() => {
    const run = jasmine.createSpy('run').and.resolveTo({ success: true });
    const kill = jasmine.createSpy('kill').and.resolveTo({ success: false });
    const status = jasmine.createSpy('status').and.resolveTo({ state: 'running' });
    window['cmd'] = { run, kill, status, onData: () => () => {} };
    const service = new CmdService({ update() {} } as any);
    const controller = new AbortController();
    const reject = jasmine.createSpy('cancelled');
    void service.runAsync('npm install', '/first', true, true, {
      streamId: 'first', signal: controller.signal
    }).catch(reject);
    controller.abort();
    flushMicrotasks();
    expect(kill).toHaveBeenCalledOnceWith('first');
    expect(reject).toHaveBeenCalledOnceWith(jasmine.objectContaining({ code: 'PROJECT_COMMAND_CANCELLED' }));
    expect(status).not.toHaveBeenCalled();
    expect(service.isProcessing()).toBeFalse();
  }));

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
      expect(options.onOutput).toBeUndefined();
      setTimeout(() => {
        const listener = listeners.get(options.streamId)!;
        listener({ type: 'stdout', streamId: options.streamId, data: 'Download progress: 20%\r' });
        listener({ type: 'stderr', streamId: options.streamId, data: 'Extraction progress: 60%\r' });
        listener({ type: 'close', streamId: options.streamId, code: 0 });
      }, 0);
      return { success: true };
    });
    window['cmd'] = { run, onData: (id: string, listener: (event: any) => void) => {
      listeners.set(id, listener); return () => listeners.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    const onOutput = jasmine.createSpy('output');
    await service.runAsyncChecked('npm run postinstall', '/sdk', queued, false, { onOutput });
    expect(onOutput.calls.allArgs().map(([output]: any[]) => output.type)).toEqual(['stdout', 'stderr', 'close']);
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
    const onOutput = jasmine.createSpy('output');
    const pending = service.runAsyncChecked('npm run postinstall', '/package', false, true, {
      streamId: 'install', projectPath: '/project', projectSessionId: 'opening', signal: controller.signal,
      onOutput,
    });
    const rejected = expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_COMMAND_CANCELLED' }));
    const options = run.calls.mostRecent().args[0];
    expect(options.projectPath).toBe('/project');
    expect(options.projectSessionId).toBe('opening');
    expect('signal' in options).toBeFalse();
    expect('onOutput' in options).toBeFalse();
    listener({ type: 'stdout', streamId: 'install', data: 'Download progress: 20%\r' });
    expect(onOutput).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    listener({ type: 'stderr', streamId: 'install', data: 'late failure' });
    listener({ type: 'close', streamId: 'install', code: 1 });
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledTimes(1);
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

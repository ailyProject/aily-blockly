import { CmdService } from './cmd.service';

describe('CmdService resource handoff', () => {
  let oldCmd: any;
  beforeEach(() => { oldCmd = window['cmd']; });
  afterEach(() => { window['cmd'] = oldCmd; });

  for (const queued of [true, false]) it(`forwards write lease through ${queued ? 'queued' : 'direct'} checked commands`, async () => {
    const listeners = new Map<string, (event: any) => void>();
    const run = jasmine.createSpy('run').and.callFake(async (options: any) => {
      setTimeout(() => listeners.get(options.streamId)!({ type: 'close', streamId: options.streamId, code: 0 }), 0);
      return { success: true };
    });
    window['cmd'] = { run, onData: (id: string, listener: (event: any) => void) => {
      listeners.set(id, listener); return () => listeners.delete(id);
    } };
    const service = new CmdService({ update() {} } as any);
    await service.runAsyncChecked('npm run postinstall', '/sdk', queued, false,
      { appDataResourceToken: 'writer-token', appDataResourceMode: 'write' });
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      command: 'npm', args: ['run', 'postinstall'], cwd: '/sdk',
      appDataResourceToken: 'writer-token', appDataResourceMode: 'write',
    }));
    expect(listeners.size).toBe(0);
  });

  it('preserves the exact build request and resource owner on direct spawn', async () => {
    let listener: (event: any) => void;
    const run = jasmine.createSpy('run').and.callFake(async (options: any) => {
      setTimeout(() => listener({ type: 'close', streamId: options.streamId, code: 0 }), 0);
      return { success: true, buildDeliveryHandle: 'host-handle' };
    });
    window['cmd'] = { run, onData: (_id: string, fn: (event: any) => void) => { listener = fn; return () => {}; } };
    const service = new CmdService({ update() {} } as any);
    const request = '/project/.temp/compile-request.json';
    await new Promise<void>((resolve, reject) => service.spawn('node', ['/child/compile.js', request], {
      buildWorkspace: '/project', buildDeliveryRequest: request, appDataResourceToken: 'reader', shellProfile: false,
    }).subscribe({ error: reject, complete: resolve }));
    expect(run.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      buildDeliveryRequest: request, buildWorkspace: '/project', appDataResourceToken: 'reader', shellProfile: false,
    }));
  });
});

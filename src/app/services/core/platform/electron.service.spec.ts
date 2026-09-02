import { ElectronService, type RendererLifecycleEvent } from './electron.service';

describe('ElectronService renderer lifecycle', () => {
  const originalElectronApi = window['electronAPI'];
  const originalIpcRenderer = window['ipcRenderer'];

  afterEach(() => {
    window['electronAPI'] = originalElectronApi;
    window['ipcRenderer'] = originalIpcRenderer;
  });

  it('tracks suspend and screen-lock state for the current renderer generation', async () => {
    const listeners = new Map<string, (event: unknown, payload: any) => void>();
    const ipcRenderer = {
      on: jasmine.createSpy('on').and.callFake((channel: string, listener: (event: unknown, payload: any) => void) => {
        listeners.set(channel, listener);
      }),
      invoke: jasmine.createSpy('invoke').and.resolveTo(7),
      send: jasmine.createSpy('send'),
    };
    window['electronAPI'] = {
      versions: () => ({}),
      ipcRenderer,
    } as any;

    const service = new ElectronService();
    const received: RendererLifecycleEvent[] = [];
    service.rendererLifecycle$.subscribe(event => received.push(event));
    await service.init();
    await service.sendRendererReady();
    listeners.get('renderer-ready-ack')?.({}, { generation: 7 });

    listeners.get('renderer-lifecycle')?.({}, { kind: 'lock-screen', generation: 7 });
    listeners.get('renderer-lifecycle')?.({}, { kind: 'suspend', generation: 7 });
    expect(service.isRendererScreenLocked).toBeTrue();
    expect(service.isRendererSuspended).toBeTrue();

    listeners.get('renderer-lifecycle')?.({}, { kind: 'resume', generation: 7 });
    expect(service.isRendererSuspended).toBeFalse();
    expect(service.isRendererScreenLocked).toBeTrue();

    listeners.get('renderer-lifecycle')?.({}, { kind: 'unlock-screen', generation: 7 });
    expect(service.isRendererScreenLocked).toBeFalse();
    expect(received.map(event => event.kind)).toEqual([
      'lock-screen',
      'suspend',
      'resume',
      'unlock-screen',
    ]);
  });

  it('ignores lifecycle messages from a stale renderer generation', async () => {
    const listeners = new Map<string, (event: unknown, payload: any) => void>();
    const ipcRenderer = {
      on: (_channel: string, _listener: (event: unknown, payload: any) => void) => {
        listeners.set(_channel, _listener);
      },
    };
    window['electronAPI'] = { versions: () => ({}), ipcRenderer } as any;
    const service = new ElectronService();
    const received: RendererLifecycleEvent[] = [];
    service.rendererLifecycle$.subscribe(event => received.push(event));
    await service.init();
    listeners.get('renderer-ready-ack')?.({}, { generation: 8 });

    listeners.get('renderer-lifecycle')?.({}, { kind: 'lock-screen', generation: 7 });
    expect(service.isRendererScreenLocked).toBeFalse();
    expect(received).toEqual([]);
  });
});

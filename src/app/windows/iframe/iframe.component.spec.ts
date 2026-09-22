import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Connection } from 'penpal';
import { IframeComponent } from './iframe.component';

describe('IframeComponent connection graph reload', () => {
  const previousIpcRenderer = window['ipcRenderer'];

  afterEach(() => {
    window['ipcRenderer'] = previousIpcRenderer;
  });

  function createReloadFixture(respond: boolean) {
    let shouldRespond = respond;
    const graph = {
      components: [{ refId: 'board' }],
      connections: [{ from: { ref: 'board', pinId: '1' }, to: { ref: 'led', pinId: '1' } }],
    };
    const removeListener = jasmine.createSpy('removeListener');
    const receiveData = jasmine.createSpy('receiveData').and.resolveTo();
    let listener: ((event: unknown, payload: unknown) => void) | undefined;
    window['ipcRenderer'] = {
      on: jasmine.createSpy('on').and.callFake((_channel: string, callback: typeof listener) => {
        listener = callback;
        return removeListener;
      }),
      send: jasmine.createSpy('send').and.callFake((_channel: string, message: any) => {
        if (shouldRespond) {
          queueMicrotask(() => listener?.(null, {
            type: 'set-graph-data',
            data: { messageId: message.data.messageId, payload: graph },
          }));
        }
      }),
    };

    const component = new IframeComponent(
      null,
      null as any,
      null as any,
      { isElectron: true } as any,
      null as any,
      null as any,
      { run: (callback: () => unknown) => callback() } as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );
    const connection = {} as Connection;
    (component as any).penpalConnection = connection;
    (component as any).penpalConnectionGeneration = 1;
    (component as any).remoteApi = {
      receiveData,
      getConnections: () => graph.connections,
    };
    component.isConnectionGraphWindow = true;
    return {
      component,
      connection,
      graph,
      receiveData,
      removeListener,
      setRespond: (value: boolean) => { shouldRespond = value; },
    };
  }

  it('loads the persisted graph from the main window after a full reload', fakeAsync(() => {
    const fixture = createReloadFixture(true);

    void (fixture.component as any).restoreConnectionGraphData(fixture.connection, 1);
    flushMicrotasks();

    expect(fixture.receiveData).toHaveBeenCalledWith(fixture.graph);
    expect(fixture.component.isLoading).toBeFalse();
    expect(fixture.component.showEmptyState).toBeFalse();
    expect(fixture.removeListener).toHaveBeenCalledTimes(1);
  }));

  it('stops loading and allows retry when the main window does not respond', fakeAsync(() => {
    const fixture = createReloadFixture(false);

    void (fixture.component as any).restoreConnectionGraphData(fixture.connection, 1);
    tick(5000);
    flushMicrotasks();

    expect(fixture.receiveData).not.toHaveBeenCalled();
    expect(fixture.component.isLoading).toBeFalse();
    expect(fixture.component.showEmptyState).toBeTrue();
    expect(fixture.removeListener).toHaveBeenCalledTimes(1);

    fixture.setRespond(true);
    fixture.component.retryConnectionGraphLoad();
    flushMicrotasks();

    expect(fixture.receiveData).toHaveBeenCalledWith(fixture.graph);
    expect(fixture.component.showEmptyState).toBeFalse();
    expect(fixture.removeListener).toHaveBeenCalledTimes(2);
  }));
});

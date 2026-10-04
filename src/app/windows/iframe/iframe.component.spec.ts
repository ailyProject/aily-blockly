import { IframeComponent, type IframeModalData } from './iframe.component';

describe('IframeComponent generic tool surface', () => {
  function createFixture(data: IframeModalData | null = null) {
    const sanitize = jasmine.createSpy('bypassSecurityTrustResourceUrl').and.callFake(url => url);
    return new IframeComponent(data, { bypassSecurityTrustResourceUrl: sanitize } as any,
      {} as any, { isElectron: false } as any);
  }

  it('keeps a component-viewer URL and opaque initialization data without owning a project graph', () => {
    const data = { url: 'https://tools.example.test/component-viewer', title: 'Viewer', data: { component: 'led' } };
    const component = createFixture(data);
    expect(component.iframeSrc).toBe(data.url);
    expect(component.windowTitle).toBe('Viewer');
    expect(component.isComponentViewerWindow).toBeTrue();
    expect((component as any).iframeData).toEqual(data.data);
    expect('isConnectionGraphWindow' in component).toBeFalse();
    expect('restoreConnectionGraphData' in component).toBeFalse();
  });

  it('reports iframe loading failures without introducing a runtime or graph recovery loop', () => {
    const component = createFixture();
    component.handleLoadError();
    expect(component.isLoading).toBeFalse();
    expect(component.showEmptyState).toBeTrue();
  });

  it('releases its messaging connection and window subscription once on destroy', async () => {
    const component = createFixture();
    const destroy = jasmine.createSpy('destroy');
    const cleanup = jasmine.createSpy('cleanup');
    const receiveData = jasmine.createSpy('receiveData').and.resolveTo('ack');
    (component as any).penpalConnection = { destroy };
    (component as any).initDataCleanup = cleanup;
    (component as any).remoteApi = { receiveData };
    expect(await component.callRemote('receiveData', { value: 1 })).toBe('ack');
    expect(receiveData).toHaveBeenCalledOnceWith({ value: 1 });
    component.ngOnDestroy();
    component.ngOnDestroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((component as any).remoteApi).toBeNull();
  });
});

import { SubWindowComponent } from './sub-window.component';

describe('SubWindowComponent macOS native close bridge', () => {
  let originalIWindow: any;

  beforeEach(() => {
    originalIWindow = window['iWindow'];
  });

  afterEach(() => {
    window['iWindow'] = originalIWindow;
  });

  it('routes a native close request through the component close output and unregisters it', () => {
    let closeRequest!: () => void;
    const unsubscribe = jasmine.createSpy('unsubscribeCloseRequest');
    window['iWindow'] = {
      onCloseRequest: jasmine.createSpy('onCloseRequest').and.callFake((callback: () => void) => {
        closeRequest = callback;
        return unsubscribe;
      }),
    };

    const component = Object.create(SubWindowComponent.prototype) as any;
    component.platformService = { isMac: () => true };
    component.electronService = {
      isElectron: true,
      onWindowFullScreenChanged: () => () => undefined,
      onWindowMaximizeChanged: () => () => undefined,
    };
    component.cd = { detectChanges: jasmine.createSpy('detectChanges') };
    component.closeEvent = { observed: true, emit: jasmine.createSpy('emit') };

    component.ngAfterViewInit();
    closeRequest();
    expect(component.closeEvent.emit).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

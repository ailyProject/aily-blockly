import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ElectronService, PlatformService } from '@core/platform/public-api';
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

describe('SubWindowComponent title-bar close control', () => {
  for (const isMac of [false, true]) {
    it(isMac ? 'keeps the custom close button hidden under the macOS native title bar'
      : 'routes a named detached close button through the component close output', () => {
      TestBed.configureTestingModule({
        imports: [SubWindowComponent, TranslateModule.forRoot()],
        providers: [provideRouter([]),
          { provide: PlatformService, useValue: { isMac: () => isMac } },
          { provide: ElectronService, useValue: { isElectron: false, isWindowFullScreen: () => false } },
        ],
      });
      const translation = TestBed.inject(TranslateService);
      translation.setTranslation('en', { COMMON: { CLOSE: 'Close' } });
      translation.use('en');
      const fixture = TestBed.createComponent(SubWindowComponent);
      const closeRequested = jasmine.createSpy('closeRequested');
      fixture.componentInstance.closeEvent.subscribe(closeRequested);
      fixture.detectChanges();

      const host: HTMLElement = fixture.nativeElement;
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(button).not.toBeNull();
      expect(getComputedStyle(button).display === 'none').toBe(isMac);
      if (!isMac) {
        button.click();
        expect(closeRequested).toHaveBeenCalledTimes(1);
      }
    });
  }
});

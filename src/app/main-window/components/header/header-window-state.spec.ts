import { HeaderComponent } from './header.component';

describe('Header native window state', () => {
  let previous: any;
  beforeEach(() => { previous = window['iWindow']; });
  afterEach(() => { window['iWindow'] = previous; });

  it('waits for authoritative restore state instead of immediately reading stale native maximized state', async () => {
    let complete!: (result: any) => void;
    window['iWindow'] = {
      toggleMaximize: jasmine.createSpy('toggle').and.returnValue(new Promise(resolve => complete = resolve)),
      isMaximized: jasmine.createSpy('stale native state').and.returnValue(false),
    };
    const header = Object.create(HeaderComponent.prototype) as any;
    header.cd = { detectChanges: jasmine.createSpy('detectChanges') };
    header._isWindowFullScreen = true;
    const pending = header.maximize();
    expect(header.isWindowFullScreen).toBeTrue();
    complete({ success: true, state: { canRestore: false } }); await pending;
    expect(header.isWindowFullScreen).toBeFalse();
    expect(window['iWindow'].isMaximized).not.toHaveBeenCalled();
  });

  it('shows restore for a fullscreen window even when native maximized is false', async () => {
    window['iWindow'] = { toggleMaximize: async () => ({ success: true, state: { canRestore: true, maximized: false, fullScreen: true } }) };
    const header = Object.create(HeaderComponent.prototype) as any;
    header.cd = { detectChanges: jasmine.createSpy('detectChanges') };
    await header.maximize();
    expect(header.isWindowFullScreen).toBeTrue();
  });
});

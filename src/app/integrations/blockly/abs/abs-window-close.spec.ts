import { HeaderComponent } from '../../../main-window/components/header/header.component';

describe('main-window close confirmation', () => {
  let view: any, original: any;
  beforeEach(() => {
    original = window['iWindow'];
    window['iWindow'] = { close: jasmine.createSpy('close'), confirmClose: jasmine.createSpy('reply') };
    view = Object.create(HeaderComponent.prototype);
    view.checkUnsavedChanges = jasmine.createSpy('check').and.resolveTo(true);
    view.message = { error: jasmine.createSpy('error') };
  });
  afterEach(() => { window['iWindow'] = original; });

  it('routes the HTML close through main without a duplicate save check', () => {
    view.close();
    expect(window['iWindow'].close).toHaveBeenCalledTimes(1);
    expect(view.checkUnsavedChanges).not.toHaveBeenCalled();
  });
  for (const allowed of [false, true]) it(`returns the awaited decision (${allowed}) with the request identity`, async () => {
    let finish!: (allowed: boolean) => void;
    view.checkUnsavedChanges.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = view.confirmWindowClose({ requestId: 'quit-one' });
    expect(window['iWindow'].confirmClose).not.toHaveBeenCalled();
    finish(allowed); await pending;
    expect(view.checkUnsavedChanges).toHaveBeenCalledOnceWith('close');
    expect(window['iWindow'].confirmClose).toHaveBeenCalledOnceWith('quit-one', allowed);
    expect(window['iWindow'].close).not.toHaveBeenCalled();
  });
  it('returns a denial after an unexpected check failure so a later quit can be retried', async () => {
    view.checkUnsavedChanges.and.rejectWith(new Error('save unavailable'));
    await view.confirmWindowClose({ requestId: 'quit-error' });
    expect(window['iWindow'].confirmClose).toHaveBeenCalledOnceWith('quit-error', false);
    expect(view.message.error).toHaveBeenCalled();
  });
  it('ignores legacy or malformed uncorrelated requests', async () => {
    for (const request of [undefined, {}, { requestId: 12 }, { requestId: '' }]) await view.confirmWindowClose(request);
    expect(view.checkUnsavedChanges).not.toHaveBeenCalled(); expect(window['iWindow'].confirmClose).not.toHaveBeenCalled();
  });
});

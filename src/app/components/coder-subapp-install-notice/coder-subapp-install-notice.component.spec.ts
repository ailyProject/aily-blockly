import { BehaviorSubject } from 'rxjs';

import { CoderSubappInstallNoticeComponent } from './coder-subapp-install-notice.component';
import { RequiredSubappState } from '@integration/subapps/public-api';

function state(status: RequiredSubappState['status']): RequiredSubappState {
  return {
    id: 'aily-coder-editor',
    status,
    installed: status === 'installed',
    installing: status === 'installing',
    percent: status === 'installed' ? 100 : 0,
  };
}

function createComponent(
  product: 'blockly' | 'coder',
  ensureInstalled: jasmine.Spy,
) {
  const stateSubject = new BehaviorSubject(state('not-installed'));
  const component = Object.create(
    CoderSubappInstallNoticeComponent.prototype,
  ) as any;
  component.configService = {
    init: jasmine.createSpy('init').and.resolveTo(),
    isCoderProduct: () => product === 'coder',
  };
  component.requiredSubapps = {
    observe: jasmine.createSpy('observe').and.returnValue(stateSubject),
    ensureInstalled,
  };
  component.cdr = { markForCheck: jasmine.createSpy('markForCheck') };
  component.state = state('loading');
  component.startingInstallation = false;
  component.stateSubscription = null;
  component.destroyed = false;
  return { component, stateSubject };
}

describe('CoderSubappInstallNoticeComponent', () => {
  it('installs the editor automatically only for the standalone Coder product', async () => {
    const coderInstall = jasmine
      .createSpy('ensureInstalled')
      .and.resolveTo({ installedNow: true });
    const coder = createComponent('coder', coderInstall);
    await coder.component.ngOnInit();
    expect(coderInstall).toHaveBeenCalledOnceWith('aily-coder-editor');

    const blocklyInstall = jasmine
      .createSpy('ensureInstalled')
      .and.resolveTo({ installedNow: true });
    const blockly = createComponent('blockly', blocklyInstall);
    await blockly.component.ngOnInit();
    expect(blocklyInstall).not.toHaveBeenCalled();
    expect(blockly.component.requiredSubapps.observe).not.toHaveBeenCalled();
  });

  it('keeps a failed installation visible and allows a user retry', async () => {
    const ensureInstalled = jasmine
      .createSpy('ensureInstalled')
      .and.rejectWith(new Error('network offline'));
    const { component, stateSubject } = createComponent(
      'coder',
      ensureInstalled,
    );

    await component.ngOnInit();
    await Promise.resolve();
    stateSubject.next({ ...state('error'), error: 'network offline' });
    expect(component.visible).toBeTrue();
    expect(component.installing).toBeFalse();

    component.retry();
    expect(ensureInstalled).toHaveBeenCalledTimes(2);
  });

  it('hides the notice as soon as a runnable editor is installed', async () => {
    const ensureInstalled = jasmine
      .createSpy('ensureInstalled')
      .and.resolveTo({ installedNow: false });
    const { component, stateSubject } = createComponent(
      'coder',
      ensureInstalled,
    );

    await component.ngOnInit();
    stateSubject.next(state('installed'));

    expect(component.visible).toBeFalse();
  });
});

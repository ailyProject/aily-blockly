import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { HeaderComponent } from './header.component';

describe('Header board configuration in Coder and Blockly', () => {
  function fixture(coder = true): any {
    const header: any = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/a', currentBoardConfig: { core: 'esp32', type: 'esp32:esp32:esp32s3' },
      isAilyCodeProject: () => coder,
      getBoardConfigMenu: async () => [{ name: 'CDC', key: 'CDCOnBoot', children: [{ key: 'CDCOnBoot', data: 'cdc' }] }],
      getPackageJson: async () => ({ projectConfig: {} }), setPackageJson: jasmine.createSpy('set package').and.resolveTo(),
      refreshRuntimeBoardConfig: jasmine.createSpy('runtime board').and.resolveTo(),
    };
    header.serialService = { getSerialPorts: async () => [{ name: '/dev/test' }] };
    header.cd = { detectChanges: () => {} };
    header.translate = { instant: (key: string) => key };
    header.supportsLinuxBoardConnector = () => false;
    Object.defineProperty(header, 'isLinuxBoardProject', { value: false });
    header.canShowBleOtaPorts = async () => false;
    header.canShowNetworkOtaPorts = async () => false;
    header.portListGeneration = 0;
    header.cachedDebuggerItems = [];
    header.coderBoardConfig = { select: jasmine.createSpy('coder config').and.resolveTo(true) };
    header.builderService = { triggerPreprocess: jasmine.createSpy('blockly preprocess') };
    header.message = { error: jasmine.createSpy('error') };
    header.selectDebounceTimer = null;
    return header;
  }
  it('uses identical board menu entries for the same board in both editors', async () => {
    const coder = fixture(), blockly = fixture(false);
    await coder.getDevicePortList(true); await blockly.getDevicePortList(true);
    expect(coder.configList).toEqual(blockly.configList);
    expect(coder.configList.some((item: any) => item.key === 'CDCOnBoot')).toBeTrue();
  });
  it('can reopen a cached board menu without its opening click reaching the outside-click closer', () => {
    const header = fixture();
    header.calculatePortListPosition = () => {};
    header.getDevicePortList = () => {};
    header.closePortList = () => { header.showPortList = false; };
    const button = document.createElement('button');
    const outside = jasmine.createSpy('outside click');
    button.addEventListener('click', event => header.openPortList(event));
    document.body.append(button); document.addEventListener('click', outside);
    try {
      button.click(); expect(header.showPortList).toBeTrue();
      button.click(); expect(header.showPortList).toBeFalse();
      button.click(); expect(header.showPortList).toBeTrue();
      expect(outside).not.toHaveBeenCalled();
    } finally { document.removeEventListener('click', outside); button.remove(); }
  });
  it('keeps the main and board menus mutually exclusive', () => {
    const header = fixture();
    header.calculatePortListPosition = () => {};
    header.getDevicePortList = () => {};
    header.closePortList = () => { header.showPortList = false; };
    header.refreshHeaderRecentProjectsMenu = () => {};
    const click = new MouseEvent('click');
    header.openMenu(click);
    expect(header.showMenu).toBeTrue();
    header.openPortList(click);
    expect(header.showMenu).toBeFalse(); expect(header.showPortList).toBeTrue();
    header.openMenu(click);
    expect(header.showMenu).toBeTrue(); expect(header.showPortList).toBeFalse();
    header.openMenu(click);
    expect(header.showMenu).toBeFalse();
  });
  it('dispatches Coder selection to saved-source synchronization, and Blockly to its existing effects', fakeAsync(() => {
    for (const coder of [true, false]) {
      const header = fixture(coder);
      header.selectSubItem({ key: 'CDCOnBoot', data: 'cdc', extra: { refreshRuntimeBoardConfig: true } });
      tick(500); flushMicrotasks();
      if (coder) {
        expect(header.coderBoardConfig.select).toHaveBeenCalledOnceWith('/a', jasmine.objectContaining({ key: 'CDCOnBoot' }));
        expect(header.builderService.triggerPreprocess).not.toHaveBeenCalled();
      } else {
        expect(header.projectService.refreshRuntimeBoardConfig).toHaveBeenCalled();
        expect(header.builderService.triggerPreprocess).toHaveBeenCalledOnceWith('config-changed');
      }
    }
  }));
  it('drops debounced selections after a project switch, and surfaces failures without an unhandled rejection', fakeAsync(() => {
    const header = fixture();
    header.selectSubItem({ key: 'CDCOnBoot', data: 'cdc' });
    header.projectService.currentProjectPath = '/b';
    tick(500); flushMicrotasks();
    expect(header.coderBoardConfig.select).not.toHaveBeenCalled();
    header.coderBoardConfig.select.and.rejectWith(new Error('save failed'));
    header.selectSubItem({ key: 'CDCOnBoot', data: 'cdc' });
    tick(500); flushMicrotasks();
    expect(header.message.error).toHaveBeenCalledOnceWith('save failed');
  }));
});

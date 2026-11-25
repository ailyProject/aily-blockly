import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { HeaderComponent } from './header.component';

describe('Header board configuration in Coder and Blockly', () => {
  function fixture(coder = true): any {
    const header: any = Object.create(HeaderComponent.prototype);
    header.projectService = {
      currentProjectPath: '/a', currentBoardConfig: { core: 'esp32', type: 'esp32:esp32:esp32s3' },
      getRuntimeBoardModule: () => '@aily-project/board-test',
      isBoardConfigMenuSnapshotCurrent: () => true,
      isAilyCodeProject: () => coder, captureCurrentProjectGuard: () => () => true,
      applyBoardConfiguration: jasmine.createSpy('persist Blockly configuration').and.resolveTo({ changed: true }),
      getBoardConfigMenu: async () => [{ name: 'CDC', key: 'CDCOnBoot', children: [{ key: 'CDCOnBoot', data: 'cdc' }] }],
      getPackageJson: async () => ({ projectConfig: {} }), setPackageJson: jasmine.createSpy('set package').and.resolveTo(),
      refreshRuntimeBoardConfig: jasmine.createSpy('runtime board').and.resolveTo(),
    };
    header.serialService = { getSerialPorts: async () => [{ name: '/dev/test' }] };
    header.cd = { detectChanges: () => {}, markForCheck: () => {} };
    header.configService = { getCompileSettingsKey: () => 'local' };
    header.uploaderBleService = { isScanning: () => false, hasActiveRequest: () => false };
    header.connectorState = { selectedTransport: 'serial', endpointLabel: '' };
    header.translate = { instant: (key: string) => key };
    header.supportsLinuxBoardConnector = () => false;
    Object.defineProperty(header, 'isLinuxBoardProject', { value: false });
    header.portListGeneration = 0;
    header.cachedDebuggerItems = [];
    header.coderBoardConfig = { select: jasmine.createSpy('coder config').and.resolveTo(true) };
    header.builderService = { triggerPreprocess: jasmine.createSpy('blockly preprocess') };
    let messageCount = 0;
    header.message = { error: jasmine.createSpy('error'), remove: jasmine.createSpy('remove'),
      success: jasmine.createSpy('success').and.returnValue({ messageId: 'board-complete' }),
      loading: jasmine.createSpy('loading').and.callFake(() => ({ messageId: 'board-' + ++messageCount })) };
    return header;
  }
  it('uses identical board menu entries for the same board in both editors', async () => {
    const coder = fixture(), blockly = fixture(false);
    await coder.getDevicePortList(true); await blockly.getDevicePortList(true);
    expect(coder.configList).toEqual(blockly.configList);
    expect(coder.configList.some((item: any) => item.key === 'CDCOnBoot')).toBeTrue();
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it('shows the selector on the opening click and publishes serial, OTA and board options independently', fakeAsync(() => {
    const header = fixture();
    const ports = deferred<any[]>(), ota = deferred<any[]>(), board = deferred<any[]>();
    header.projectService.currentBoardConfig.name = 'linkbit 三色屏';
    header.serialService.getSerialPorts = () => ports.promise;
    header.getOtaPortMenuItems = () => ota.promise;
    header.projectService.getBoardConfigMenu = () => board.promise;
    header.calculatePortListPosition = () => {};
    header.openPortList(new MouseEvent('click'));
    const actions = () => header.configList.filter(item => !item.sep).map(item => item.action || item.name);
    expect(header.showPortList).toBeTrue();
    expect(actions()).toEqual(['board-select']);
    ports.resolve([{ name: '/dev/usbmodem-test' }]);
    flushMicrotasks();
    expect(actions()).toEqual(['/dev/usbmodem-test', 'board-select']);
    board.resolve([{ name: 'CDCOnBoot' }]);
    flushMicrotasks();
    expect(actions()).toEqual(['/dev/usbmodem-test', 'CDCOnBoot', 'board-select']);
    ota.resolve([{ name: 'WiFi OTA' }]);
    flushMicrotasks();
    expect(actions()).toEqual(['/dev/usbmodem-test', 'WiFi OTA', 'CDCOnBoot', 'board-select']);
  }));

  it('keeps ports usable if cloud lookup fails and lets cloud rows arrive even if port enumeration stalls', fakeAsync(() => {
    const header = fixture();
    const ports = deferred<any[]>(), failed = deferred<any[]>();
    header.serialService.getSerialPorts = () => ports.promise;
    header.projectService.getBoardConfigMenu = () => failed.promise;
    void header.getDevicePortList();
    ports.resolve([{ name: '/dev/usb' }]); failed.reject(new Error('gateway offline'));
    flushMicrotasks();
    expect(header.configList.some(item => item.name === '/dev/usb')).toBeTrue();
    header.closePortList();
    const unknownPorts = deferred<any[]>();
    header.serialService.getSerialPorts = () => unknownPorts.promise;
    header.projectService.getBoardConfigMenu = async () => [{ name: 'Partition Scheme' }];
    void header.getDevicePortList();
    flushMicrotasks();
    expect(header.configList.some(item => item.name === 'Partition Scheme')).toBeTrue();
    unknownPorts.resolve([]);
    flushMicrotasks();
  }));

  it('discards closed, replaced and out-of-order results from normal and Linux serial menus', fakeAsync(() => {
    for (const linux of [false, true]) {
      const header = fixture();
      Object.defineProperty(header, 'linuxBoardConnectors', { value: linux ? ['serial', 'ssh'] : [] });
      const oldPorts = deferred<any[]>(), oldBoard = deferred<any[]>(), newPorts = deferred<any[]>();
      header.serialService.getSerialPorts = () => oldPorts.promise;
      header.projectService.getBoardConfigMenu = () => oldBoard.promise;
      void header.getDevicePortList();
      header.closePortList();
      header.projectService.currentProjectPath = '/new';
      header.configService.getCompileSettingsKey = () => 'cloud';
      header.serialService.getSerialPorts = () => newPorts.promise;
      header.projectService.getBoardConfigMenu = async () => [{ name: 'New config' }];
      void header.getDevicePortList();
      oldPorts.resolve([{ name: 'Old serial' }]); oldBoard.resolve([{ name: 'Old config' }]);
      newPorts.resolve([{ name: 'New serial' }]);
      flushMicrotasks();
      expect(header.configList.some(item => item.name === 'New serial')).toBeTrue();
      expect(header.configList.some(item => item.name?.startsWith('Old'))).toBeFalse();
      expect(header.configList.some(item => item.action === 'connector-settings')).toBe(linux);
    }
  }));

  it('uses the latest device scan without cancelling a pending board lookup or probe scan', fakeAsync(() => {
    const header = fixture();
    header.projectService.currentBoardConfig.linkUploadParam = '--probe';
    const probe = deferred<any>(), menu = deferred<any[]>(), slowPorts = deferred<any[]>();
    header.probeRsService = { listProbes: jasmine.createSpy('probe scan').and.returnValue(probe.promise) };
    header.projectService.getBoardConfigMenu = jasmine.createSpy('board lookup').and.returnValue(menu.promise);
    header.serialService.getSerialPorts = () => slowPorts.promise;
    void header.getDevicePortList();
    header.serialService.getSerialPorts = async () => [{ name: 'New serial' }];
    void header.getDevicePortList(true);
    void header.getDevicePortList(true);
    slowPorts.resolve([{ name: 'Old serial' }]);
    menu.resolve([{ name: 'Cloud option' }]);
    probe.resolve({ success: true, probes: [{ type: 'Debug probe', serial: '123' }] });
    flushMicrotasks();
    expect(header.configList.filter(item => !item.sep).map(item => item.name))
      .toEqual(['New serial', 'Debug probe', 'Cloud option', 'BOARD_SELECTOR.TITLE']);
    expect(header.probeRsService.listProbes).toHaveBeenCalledTimes(1);
    expect(header.projectService.getBoardConfigMenu).toHaveBeenCalledTimes(1);
  }));

  it('does not offer the previous board options while reopening an invalidated cloud target', fakeAsync(() => {
    const header = fixture();
    void header.getDevicePortList(); flushMicrotasks();
    const old = header.portMenuContent.boardOptions[0].children[0];
    header.closePortList();
    header.projectService.isBoardConfigMenuSnapshotCurrent = () => false;
    const target = deferred<any[]>();
    header.projectService.getBoardConfigMenu = () => target.promise;
    void header.getDevicePortList();
    expect(header.configList.some(item => item.key === 'CDCOnBoot')).toBeFalse();
    expect(header.configList.some(item => item.name === '/dev/test')).toBeTrue();
    header.selectSubItem(old); tick(500); flushMicrotasks();
    expect(header.coderBoardConfig.select).not.toHaveBeenCalled();
    target.resolve([{ name: 'Gateway offline', disabled: true }]); flushMicrotasks();
    expect(header.configList.some(item => item.name === 'Gateway offline')).toBeTrue();
  }));

  it('reuses rows only for the current board, connector route and compile settings', fakeAsync(() => {
    const header = fixture();
    void header.getDevicePortList();
    flushMicrotasks();
    expect(header.configList.some(item => item.key === 'CDCOnBoot')).toBeTrue();
    const options = deferred<any[]>();
    header.projectService.getBoardConfigMenu = () => options.promise;
    header.configService.getCompileSettingsKey = () => 'cloud';
    void header.getDevicePortList();
    expect(header.configList.map(item => item.action)).toEqual(['board-select']);
    options.resolve([]);
    flushMicrotasks();
    Object.defineProperty(header, 'linuxBoardConnectors', { value: ['ssh'] });
    header.serialService.getSerialPorts = jasmine.createSpy('ports');
    void header.getDevicePortList();
    expect(header.configList.filter(item => !item.sep).map(item => item.action)).toEqual(['connector-settings', 'board-select']);
    expect(header.serialService.getSerialPorts).not.toHaveBeenCalled();
  }));

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
      void header.getDevicePortList(); flushMicrotasks();
      header.selectSubItem(header.portMenuContent.boardOptions[0].children[0]);
      tick(500); flushMicrotasks();
      if (coder) {
        expect(header.coderBoardConfig.select).toHaveBeenCalledOnceWith('/a', jasmine.objectContaining({ key: 'CDCOnBoot' }));
        expect(header.builderService.triggerPreprocess).not.toHaveBeenCalled();
      } else {
        expect(header.projectService.applyBoardConfiguration).toHaveBeenCalledOnceWith(jasmine.objectContaining({ key: 'CDCOnBoot' }));
        expect(header.builderService.triggerPreprocess).toHaveBeenCalledOnceWith('config-changed');
      }
    }
  }));
  it('rechecks the current option at dispatch and keeps a valid selection after closing the menu', fakeAsync(() => {
    for (const change of ['backend', 'session', 'disabled parent', 'disabled child', 'missing', 'same choice']) {
      const header = fixture();
      let live = true;
      header.projectService.captureCurrentProjectGuard = () => () => live;
      void header.getDevicePortList(); flushMicrotasks();
      const row = header.portMenuContent.boardOptions[0], child = row.children[0];
      header.selectSubItem(child);
      if (change === 'backend') header.configService.getCompileSettingsKey = () => 'cloud';
      if (change === 'session') live = false;
      if (['disabled parent', 'disabled child', 'missing', 'same choice'].includes(change)) {
        header.projectService.getBoardConfigMenu = async () => [{ ...row, disabled: change === 'disabled parent',
          children: change === 'missing' ? [] : [{ ...child, disabled: change === 'disabled child', name: 'current' }] }];
        void header.getDevicePortList(); flushMicrotasks();
      }
      header.closePortList();
      tick(500); flushMicrotasks();
      if (change === 'same choice') {
        expect(header.coderBoardConfig.select).toHaveBeenCalledOnceWith('/a', jasmine.objectContaining({ name: 'current' }));
      } else expect(header.coderBoardConfig.select).not.toHaveBeenCalled();
    }
  }));

  it('drops debounced selections after a project switch, and surfaces failures without an unhandled rejection', fakeAsync(() => {
    const header = fixture();
    void header.getDevicePortList(); flushMicrotasks();
    header.selectSubItem(header.portMenuContent.boardOptions[0].children[0]);
    header.projectService.currentProjectPath = '/b';
    tick(500); flushMicrotasks();
    expect(header.coderBoardConfig.select).not.toHaveBeenCalled();
    header.coderBoardConfig.select.and.rejectWith(new Error('save failed'));
    void header.getDevicePortList(); flushMicrotasks();
    header.selectSubItem(header.portMenuContent.boardOptions[0].children[0]);
    tick(500); flushMicrotasks();
    expect(header.message.error).toHaveBeenCalledOnceWith('save failed');
  }));
  function boardRow(key: string, value: string, disabled?: string) {
    return { key, name: key, children: ['off', 'on'].map(data => ({ key, name: data, data,
      check: value === data, disabled: disabled === data })) };
  }

  it('starts each board settings spinner as its queued write begins', fakeAsync(() => {
    const h = fixture(false), first = deferred<any>(), second = deferred<any>();
    h.projectService.getBoardConfigMenu = async () => [boardRow('USB', 'off'), boardRow('Flash', 'off')];
    h.projectService.applyBoardConfiguration.and.returnValues(first.promise, second.promise);
    void h.getDevicePortList(); flushMicrotasks();
    for (const row of h.portMenuContent.boardOptions) h.selectSubItem(row.children[1]);
    tick(499);
    expect(h.message.loading).not.toHaveBeenCalled();
    tick(1);
    expect(h.message.loading).toHaveBeenCalledOnceWith('PROJECT.APPLYING_BOARD_SETTINGS', { nzDuration: 0 });
    first.resolve({ changed: true }); flushMicrotasks();
    expect(h.message.remove.calls.allArgs()).toEqual([['board-1'], ['board-complete']]);
    expect(h.message.success).toHaveBeenCalledOnceWith('PROJECT.BOARD_SETTINGS_APPLIED', { nzDuration: 4000, nzAnimate: false });
    expect(h.message.loading).toHaveBeenCalledTimes(2);
    second.reject(new Error('flash setting failed')); flushMicrotasks();
    expect(h.message.remove.calls.allArgs()).toEqual([['board-1'], ['board-complete'], ['board-2']]);
    expect(h.message.success).toHaveBeenCalledTimes(1);
    expect(h.message.error).toHaveBeenCalledOnceWith('flash setting failed');
  }));

  it('dismisses the previous confirmation on a new choice and leaves an unchanged setting unconfirmed', fakeAsync(() => {
    const h = fixture(true), first = deferred<boolean>(), second = deferred<boolean>();
    h.coderBoardConfig.select.and.returnValues(first.promise, second.promise);
    void h.getDevicePortList(); flushMicrotasks();
    h.selectSubItem(h.portMenuContent.boardOptions[0].children[0]); tick(500);
    first.resolve(true); flushMicrotasks();
    expect(h.message.success).toHaveBeenCalledTimes(1);
    h.selectSubItem(h.portMenuContent.boardOptions[0].children[0]);
    expect(h.message.remove.calls.allArgs()).toEqual([['board-1'], ['board-complete']]);
    tick(500); second.resolve(false); flushMicrotasks();
    expect(h.message.remove.calls.mostRecent().args).toEqual(['board-2']);
    expect(h.message.success).toHaveBeenCalledTimes(1);
  }));

  it('shows progress even for a short write and confirms it only after success', fakeAsync(() => {
    const h = fixture(false), write = deferred<any>();
    h.projectService.applyBoardConfiguration.and.returnValue(write.promise);
    void h.getDevicePortList(); flushMicrotasks();
    h.selectSubItem(h.portMenuContent.boardOptions[0].children[0]); tick(500);
    expect(h.message.loading).toHaveBeenCalledOnceWith('PROJECT.APPLYING_BOARD_SETTINGS', { nzDuration: 0 });
    expect(h.message.success).not.toHaveBeenCalled();
    tick(20); write.resolve({ changed: true }); flushMicrotasks();
    expect(h.message.remove).toHaveBeenCalledOnceWith('board-1');
    expect(h.message.success).toHaveBeenCalledOnceWith('PROJECT.BOARD_SETTINGS_APPLIED', { nzDuration: 4000, nzAnimate: false });
  }));

  it('cancels queued feedback and removes an active spinner when the header is destroyed', fakeAsync(() => {
    for (const started of [false, true]) {
      const h = fixture(false), write = deferred<any>();
      h.electronService = { isElectron: false };
      h.projectService.applyBoardConfiguration.and.returnValue(write.promise);
      void h.getDevicePortList(); flushMicrotasks();
      h.selectSubItem(h.portMenuContent.boardOptions[0].children[0]); tick(started ? 500 : 499);
      h.ngOnDestroy();
      write.resolve({ changed: true }); flushMicrotasks(); tick(2000);
      expect(h.message.loading.calls.count()).toBe(started ? 1 : 0);
      expect(h.message.remove.calls.allArgs()).toEqual(started ? [['board-1']] : []);
      expect(h.message.success).not.toHaveBeenCalled();
      expect(h.message.error).not.toHaveBeenCalled();
    }
  }));

  it('keeps the live parent and device rows while a saved choice projects a new runtime board', fakeAsync(() => {
    const header = fixture(false), refreshed = deferred<any[]>();
    header.showPortList = true;
    const first = { ...boardRow('USB', 'off'), tooltip: 'old metadata' };
    header.serialService.getSerialPorts = jasmine.createSpy('ports').and.resolveTo([{ name: 'COM4' }]);
    header.getOtaPortMenuItems = jasmine.createSpy('OTA').and.resolveTo([]);
    header.projectService.getBoardConfigMenu = jasmine.createSpy('board').and.returnValues(Promise.resolve([first]), refreshed.promise);
    header.projectService.applyBoardConfiguration.and.callFake(async () => {
      header.projectService.currentBoardConfig = { ...header.projectService.currentBoardConfig, _cdcEnabled: true };
      await header.resetDebuggerSelectionAfterBoardChange();
      return { changed: true };
    });
    void header.getDevicePortList(); flushMicrotasks();
    const device = header.configList.find(row => row.name === 'COM4');
    header.selectSubItem(first.children[1]);
    tick(500);
    expect(header.configList).toContain(first);
    expect(header.portMenuContent.board).toBe(header.projectService.currentBoardConfig);
    expect(header.serialService.getSerialPorts).toHaveBeenCalledTimes(1);
    expect(header.getOtaPortMenuItems).toHaveBeenCalledTimes(1);
    refreshed.resolve([boardRow('USB', 'on')]); flushMicrotasks();
    const row = header.configList.find(row => row.key === 'USB');
    expect(row).toBe(first); expect(row.tooltip).toBeUndefined();
    expect(row.children.map(child => child.check)).toEqual([false, true]);
    expect(header.configList.find(row => row.name === 'COM4')).toBe(device);
  }));

  it('debounces each key and serializes publications without rolling back a newer optimistic check', fakeAsync(() => {
    const header = fixture(false), firstWrite = deferred<void>();
    const state = { USB: 'off', Flash: 'off' }, writes: string[] = [];
    header.showPortList = true;
    header.projectService.getBoardConfigMenu = async () => [boardRow('USB', state.USB), boardRow('Flash', state.Flash)];
    header.projectService.applyBoardConfiguration.and.callFake(async choice => {
      writes.push(choice.key + ':' + choice.data);
      if (writes.length === 1) await firstWrite.promise;
      state[choice.key] = choice.data;
      return { changed: true };
    });
    void header.getDevicePortList(); flushMicrotasks();
    const [usb, flash] = header.portMenuContent.boardOptions;
    header.selectSubItem(usb.children[0]); tick(100);
    header.selectSubItem(usb.children[1]); tick(100);
    header.selectSubItem(flash.children[1]); tick(400);
    expect(writes).toEqual(['USB:on']);
    header.selectSubItem(usb.children[0]); firstWrite.resolve(); flushMicrotasks();
    expect(usb.children.map(child => child.check)).toEqual([true, false]);
    expect(flash.children.map(child => child.check)).toEqual([false, true]);
    tick(500);
    expect(writes).toEqual(['USB:on', 'Flash:on', 'USB:off']);
    expect(state).toEqual({ USB: 'off', Flash: 'on' });
  }));

  it('restores authoritative checks after a failed write, and drops a disabled dependent choice after closing', fakeAsync(() => {
    const header = fixture(false), reread = deferred<any[]>();
    const usb = boardRow('USB', 'off'), flash = boardRow('Flash', 'off');
    header.showPortList = true;
    header.projectService.getBoardConfigMenu = jasmine.createSpy('board').and.returnValues(Promise.resolve([usb, flash]), reread.promise);
    header.projectService.applyBoardConfiguration.and.rejectWith(new Error('save failed'));
    void header.getDevicePortList(); flushMicrotasks();
    usb.children[0].check = false; usb.children[1].check = true;
    header.selectSubItem(usb.children[1]); tick(100);
    header.selectSubItem(flash.children[1]); tick(400);
    header.closePortList();
    reread.resolve([boardRow('USB', 'off'), boardRow('Flash', 'off', 'on')]); flushMicrotasks();
    expect(usb.children.map(child => child.check)).toEqual([true, false]);
    expect(flash.children[1].disabled).toBeTrue();
    tick(500);
    expect(header.projectService.applyBoardConfiguration).toHaveBeenCalledTimes(1);
    expect(header.message.error).toHaveBeenCalledOnceWith('save failed');
  }));

  it('cannot adopt a different board package, even if a save is in progress and its FQBN matches', fakeAsync(() => {
    const header = fixture(false), write = deferred<any>();
    const usb = boardRow('USB', 'off');
    header.showPortList = true;
    header.projectService.getBoardConfigMenu = jasmine.createSpy('board').and.resolveTo([usb]);
    header.projectService.applyBoardConfiguration.and.returnValue(write.promise);
    void header.getDevicePortList(); flushMicrotasks();
    header.selectSubItem(usb.children[1]); tick(500);
    header.projectService.currentBoardConfig = { ...header.projectService.currentBoardConfig };
    header.projectService.getRuntimeBoardModule = () => '@aily-project/board-different';
    const newMenu = deferred<any[]>();
    header.projectService.getBoardConfigMenu.and.returnValue(newMenu.promise);
    void header.resetDebuggerSelectionAfterBoardChange(); flushMicrotasks();
    expect(header.configList).not.toContain(usb);
    write.resolve({ changed: true }); newMenu.resolve([boardRow('other', 'off')]); flushMicrotasks();
    expect(header.configList.some(row => row.key === 'other')).toBeTrue();
    expect(header.projectService.getBoardConfigMenu).toHaveBeenCalledTimes(2);
  }));

  it('cancels pending writes and post-save hardware actions when a real board switch starts', fakeAsync(() => {
    for (const before of [true, false]) {
      const header = fixture(false), write = deferred<any>();
      const row = boardRow('SoftDevice', 'off');
      Object.assign(row.children[1], { extra: { selectAction: 'flash-softdevice' } });
      header.projectService.getBoardConfigMenu = async () => [row];
      header.projectService.applyBoardConfiguration.and.returnValue(write.promise);
      header.serialService.currentPort = 'COM4';
      header.uploaderService = { flashSoftdevice: jasmine.createSpy('flash') };
      void header.getDevicePortList(); flushMicrotasks();
      header.selectSubItem(row.children[1]);
      if (before) header.projectService.isBoardSwitchInProgress = true;
      tick(500);
      header.projectService.isBoardSwitchInProgress = true;
      write.resolve({ changed: true }); flushMicrotasks();
      expect(header.projectService.applyBoardConfiguration.calls.count()).toBe(before ? 0 : 1);
      expect(header.uploaderService.flashSoftdevice).not.toHaveBeenCalled();
      expect(header.builderService.triggerPreprocess).not.toHaveBeenCalled();
    }
  }));

  it('waits for a reopened menu to verify an already queued choice against its latest options', fakeAsync(() => {
    for (const allowed of [true, false]) {
      const header = fixture(false), readAfterWrite = deferred<any[]>(), reopened = deferred<any[]>();
      const initial = [boardRow('USB', 'off'), boardRow('Flash', 'off')];
      header.showPortList = true;
      header.projectService.getBoardConfigMenu = jasmine.createSpy('menu').and.returnValues(
        Promise.resolve(initial), readAfterWrite.promise, reopened.promise, Promise.resolve(initial));
      void header.getDevicePortList(); flushMicrotasks();
      header.selectSubItem(initial[0].children[1]); header.selectSubItem(initial[1].children[1]); tick(500);
      header.closePortList(); header.showPortList = true;
      void header.getDevicePortList();
      readAfterWrite.resolve(initial); flushMicrotasks();
      expect(header.projectService.applyBoardConfiguration).toHaveBeenCalledTimes(1);
      reopened.resolve([boardRow('USB', 'on'), boardRow('Flash', 'off', allowed ? undefined : 'on')]);
      flushMicrotasks();
      expect(header.projectService.applyBoardConfiguration.calls.count()).toBe(allowed ? 2 : 1);
    }
  }));

  it('paints verified board options, serial, OTA and probes together on every warm open while sources refresh', fakeAsync(() => {
    const h = fixture(false), lateRows = deferred<any[]>(), latePorts = deferred<any[]>(), lateOta = deferred<any[]>(), lateProbes = deferred<any>();
    const rows = [boardRow('UploadSpeed', 'off')];
    h.projectService.currentBoardConfig.linkUploadParam = '--probe';
    h.projectService.isBoardConfigMenuSnapshotCurrent = value => value === rows;
    h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(Promise.resolve(rows), lateRows.promise, lateRows.promise);
    h.serialService.getSerialPorts = jasmine.createSpy('ports').and.returnValues(Promise.resolve([{ name: 'COM8' }]), latePorts.promise, latePorts.promise);
    h.getOtaPortMenuItems = jasmine.createSpy('OTA').and.returnValues(Promise.resolve([{ name: 'WiFi' }]), lateOta.promise, lateOta.promise);
    h.probeRsService = { listProbes: jasmine.createSpy('probes').and.returnValues(Promise.resolve({ success: true, probes: [{ type: 'Debug' }] }), lateProbes.promise, lateProbes.promise) };
    h.calculatePortListPosition = () => {};
    const open = () => h.openPortList(new MouseEvent('click'));
    const names = () => h.configList.filter(x => !x.sep).map(x => x.name);
    open();
    expect(names()).toEqual(['BOARD_SELECTOR.TITLE']);
    flushMicrotasks();
    const complete = ['COM8', 'WiFi', 'Debug', 'UploadSpeed', 'BOARD_SELECTOR.TITLE'];
    expect(names()).toEqual(complete);
    h.closePortList(); open();
    expect(names()).toEqual(complete);
    h.closePortList(); open();
    expect(names()).toEqual(complete);
    expect(h.projectService.getBoardConfigMenu).toHaveBeenCalledTimes(3);
    lateRows.resolve([boardRow('USB', 'off')]); latePorts.resolve([{ name: 'COM9' }]); lateOta.resolve([]); lateProbes.resolve({success: true, probes: []}); flushMicrotasks();
    expect(names()).toEqual(['COM9', 'USB', 'BOARD_SELECTOR.TITLE']);
  }));

  it('uses the verified result of a warm refresh before applying a displayed choice', fakeAsync(() => {
    for (const allowed of [true, false]) {
      const h = fixture(false), next = deferred<any[]>();
      const row = boardRow('USB', 'off');
      h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(Promise.resolve([row]), next.promise, Promise.resolve([row]));
      void h.getDevicePortList(); flushMicrotasks(); h.closePortList(); h.showPortList = true;
      void h.getDevicePortList(); expect(h.configList).toContain(row);
      h.selectSubItem(row.children[1]); tick(500);
      expect(h.projectService.applyBoardConfiguration).not.toHaveBeenCalled();
      next.resolve([boardRow('USB', 'off', allowed ? undefined : 'on')]); flushMicrotasks();
      expect(h.projectService.applyBoardConfiguration.calls.count()).toBe(allowed ? 1 : 0);
    }
  }));

  it('reopens confirmed cloud and SDK unavailability with every row read-only until the next lookup completes', fakeAsync(() => {
    for (const status of ['PROJECT.CLOUD_BOARD_OFFLINE', 'PROJECT.SDK_CONFIG_NOT_READY']) {
      const h = fixture(false), lookup = deferred<any[]>();
      const recovered = boardRow('USB', 'off');
      // With no SDK, the board package can still supply a static menu option.
      const initial = { ...boardRow('USB', 'off'), disabled: status === 'PROJECT.CLOUD_BOARD_OFFLINE' };
      const warning = { type: 'board-config-unavailable', name: status, disabled: true };
      const ready = [recovered];
      h.projectService.isBoardConfigMenuSnapshotCurrent = rows => rows === ready;
      h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(
        Promise.resolve([warning, initial]), lookup.promise, Promise.resolve(ready));
      h.showPortList = true; void h.getDevicePortList(); flushMicrotasks();
      const names = () => h.configList.filter(item => !item.sep).map(item => item.name);
      const before = names();
      h.closePortList(); h.showPortList = true; void h.getDevicePortList();
      expect(names()).withContext(status).toEqual(before);
      expect(h.configList.find(item => item.key === 'USB').disabled).withContext(status).toBeTrue();
      h.selectSubItem(initial.children[1]); tick(500);
      expect(h.projectService.applyBoardConfiguration).not.toHaveBeenCalled();
      lookup.resolve(ready); flushMicrotasks();
      expect(names()).not.toContain(status);
      expect(h.configList.find(item => item.key === 'USB').disabled).toBeFalsy();
      h.selectSubItem(recovered.children[1]); tick(500);
      expect(h.projectService.applyBoardConfiguration).toHaveBeenCalledTimes(1);
    }
  }));

  it('reopens against settled disk state after the choice succeeds or fails while the menu is closed', fakeAsync(() => {
    for (const succeeds of [true, false]) {
      const h = fixture(false), write = deferred<any>(), latest = deferred<any[]>();
      const initial = boardRow('USB', 'off');
      h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(
        Promise.resolve([initial]), latest.promise, new Promise(() => {}));
      h.projectService.applyBoardConfiguration.and.returnValue(write.promise);
      h.showPortList = true; void h.getDevicePortList(); flushMicrotasks();
      initial.children[0].check = false; initial.children[1].check = true;
      h.selectSubItem(initial.children[1]); h.closePortList(); tick(500);
      if (succeeds) write.resolve({ changed: true }); else write.reject(new Error('save failed'));
      flushMicrotasks(); expect(h.projectService.getBoardConfigMenu).toHaveBeenCalledTimes(2);
      latest.resolve([boardRow('USB', succeeds ? 'on' : 'off')]); flushMicrotasks();
      h.showPortList = true; void h.getDevicePortList();
      expect(h.configList.find(x => x.key === 'USB').children.map(child => child.check)).toEqual([!succeeds, succeeds]);
    }
  }));

  it('invalidates a closed board snapshot on an external board-change notification even with the same runtime object', fakeAsync(() => {
    const h = fixture(false), oldRead = deferred<any[]>(), read = deferred<any[]>();
    h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(
      Promise.resolve([boardRow('USB', 'off')]), oldRead.promise, read.promise);
    void h.getDevicePortList(); flushMicrotasks(); h.closePortList();
    h.showPortList = true; void h.getDevicePortList(); h.closePortList();
    void h.resetDebuggerSelectionAfterBoardChange(); flushMicrotasks();
    oldRead.resolve([boardRow('USB', 'on')]); flushMicrotasks();
    h.showPortList = true; void h.getDevicePortList();
    expect(h.configList.some(x => x.key === 'USB')).toBeFalse();
    read.resolve([boardRow('Flash', 'on')]); flushMicrotasks();
    expect(h.configList.some(x => x.key === 'Flash')).toBeTrue();
  }));

  it('cancels a superseded custom partition action while the warm menu verifies both choices', fakeAsync(() => {
    const h = fixture(false), lookup = deferred<any[]>();
    const row = () => ({ key: 'PartitionScheme', children: ['custom', 'default'].map(data => ({ key: 'PartitionScheme', data })) });
    const old = row();
    h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(Promise.resolve([old]), lookup.promise, Promise.resolve([row()]));
    h.openPartitionManager = jasmine.createSpy('partition manager').and.resolveTo();
    void h.getDevicePortList(); flushMicrotasks(); h.closePortList(); h.showPortList = true; void h.getDevicePortList();
    h.selectSubItem(old.children[0]); h.selectSubItem(old.children[1]); tick(500);
    lookup.resolve([row()]); flushMicrotasks();
    expect(h.openPartitionManager).not.toHaveBeenCalled();
    expect(h.projectService.applyBoardConfiguration).toHaveBeenCalledOnceWith(jasmine.objectContaining({ data: 'default' }));
  }));

  it('keeps every row and the pending radio check when reopening during debounce, publication and its readback', fakeAsync(() => {
    for (const stage of ['debounce', 'publishing', 'readback']) {
      const h = fixture(false), write = deferred<any>(), background = deferred<any[]>(), settled = deferred<any[]>();
      let proof = true;
      const original = boardRow('USB', 'off');
      const rows = () => [boardRow('USB', 'on'), boardRow('Flash', 'off')];
      h.projectService.isBoardConfigMenuSnapshotCurrent = () => proof;
      h.projectService.getBoardConfigMenu = jasmine.createSpy('options').and.returnValues(
        Promise.resolve([original, boardRow('Flash', 'off')]), background.promise, settled.promise);
      h.projectService.applyBoardConfiguration.and.returnValue(write.promise);
      h.showPortList = true; void h.getDevicePortList(); flushMicrotasks();
      const names = () => h.configList.filter(i => !i.sep).map(i => i.name);
      const usb = () => h.configList.find(i => i.key === 'USB');
      const before = names();
      original.children[0].check = false; original.children[1].check = true;
      h.selectSubItem(original.children[1]);
      if (stage !== 'debounce') tick(500);
      if (stage === 'readback') { proof = false; write.resolve({ changed: true }); flushMicrotasks(); }
      h.closePortList(); h.showPortList = true; void h.getDevicePortList();
      expect(names()).withContext(stage).toEqual(before);
      expect(usb().children.map(c => c.check)).withContext(stage).toEqual([false, true]);
      expect(!!usb().disabled).withContext(stage).toBe(stage === 'readback');
      proof = true;
      background.resolve(rows()); settled.resolve(rows()); flushMicrotasks(); tick(500);
      write.resolve({ changed: true }); flushMicrotasks();
      expect(usb().disabled).withContext(stage).toBeFalsy();
      expect(usb().children.map(c => c.check)).withContext(stage).toEqual([false, true]);
      expect(h.projectService.applyBoardConfiguration).toHaveBeenCalledTimes(1);
    }
  }));

});

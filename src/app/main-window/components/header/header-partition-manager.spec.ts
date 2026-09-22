import { BehaviorSubject } from 'rxjs';
import { RequiredSubappService } from '@integration/subapps/public-api';
import { HeaderComponent } from './header.component';

const partitionId = 'ffs-manager-child';
const custom = { key: 'PartitionScheme', data: 'custom' };

describe('Header custom partition menu', () => {
  let header: any;
  let manager: any;
  let catalog: BehaviorSubject<any>;
  let progress: BehaviorSubject<any>;

  function publish(installed: boolean, extra = {}) {
    catalog.next({ loading: false, apps: [{
      id: partitionId, installed, config: installed ? { id: partitionId } : null, ...extra,
    }] });
  }

  function holdInstall() {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const installing = new Promise<void>(resolve => { started = resolve; });
    manager.install.and.callFake(async () => {
      started();
      await pending;
      publish(true);
    });
    return { finish, installing };
  }

  beforeEach(() => {
    catalog = new BehaviorSubject<any>({ loading: false, apps: [] });
    progress = new BehaviorSubject<any>(null);
    publish(false);
    manager = {
      get state() { return catalog.value; },
      state$: catalog,
      progress$: progress,
      initialize: jasmine.createSpy('initialize').and.resolveTo(),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      install: jasmine.createSpy('install').and.callFake(async () => publish(true)),
      reinstall: jasmine.createSpy('reinstall').and.callFake(async () => publish(true)),
    };
    header = Object.create(HeaderComponent.prototype);
    header.requiredSubapps = new RequiredSubappService(manager);
    header.selectDebounceTimer = null;
    header.projectService = { currentProjectPath: 'D:\\Projects\\语音 project', setPackageJson: jasmine.createSpy('write') };
    header.uiService = { openWindow: jasmine.createSpy('openWindow'), openToolWindow: jasmine.createSpy('openToolWindow').and.returnValue(true) };
    header.closePortList = jasmine.createSpy('closeMenu');
    header.builderService = { triggerPreprocess: jasmine.createSpy('preprocess') };
    header.message = {
      loading: jasmine.createSpy('loading').and.returnValue({ messageId: 'install-notice' }),
      remove: jasmine.createSpy('remove'),
      error: jasmine.createSpy('error'),
    };
    header.electronService = { isElectron: false };
  });

  afterEach(() => {
    expect(header.uiService.openWindow).not.toHaveBeenCalled();
    expect(header.projectService.setPackageJson).not.toHaveBeenCalled();
    expect(header.builderService.triggerPreprocess).not.toHaveBeenCalled();
  });

  it('opens an installed child directly without reinstalling or changing the partition scheme', async () => {
    publish(true);
    await header.selectSubItem(custom);
    expect(manager.install).not.toHaveBeenCalled();
    expect(manager.reinstall).not.toHaveBeenCalled();
    expect(header.message.loading).not.toHaveBeenCalled();
    expect(header.uiService.openToolWindow).toHaveBeenCalledOnceWith(partitionId, jasmine.objectContaining({ width: 920, height: 820 }));
  });

  it('waits for installation, reports progress, and opens only once across repeated clicks', async () => {
    const install = holdInstall();
    const first = header.selectSubItem(custom);
    await install.installing;
    await header.selectSubItem(custom);
    expect(manager.install).toHaveBeenCalledOnceWith(partitionId);
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
    progress.next({ id: partitionId, action: 'install', phase: 'download', percent: 42 });
    expect(header.message.loading).toHaveBeenCalledOnceWith('正在安装 ESP32 分区管理器…', jasmine.objectContaining({ nzDuration: 0 }));
    install.finish();
    await first;
    expect(header.uiService.openToolWindow).toHaveBeenCalledTimes(1);
    expect(header.message.remove).toHaveBeenCalledOnceWith('install-notice');
    expect(header.closePortList).toHaveBeenCalledTimes(1);
  });

  it('reports installation failure and lets the next menu click retry', async () => {
    manager.install.and.rejectWith(new Error('network offline'));
    await header.selectSubItem(custom);
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
    expect(header.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/network offline.*重试/), jasmine.any(Object));
    expect(header.message.remove).toHaveBeenCalledOnceWith('install-notice');
    manager.install.and.callFake(async () => publish(true));
    await header.selectSubItem(custom);
    expect(manager.install).toHaveBeenCalledTimes(2);
    expect(header.uiService.openToolWindow).toHaveBeenCalledTimes(1);
  });

  it('repairs an incomplete installation before opening', async () => {
    publish(true, { config: null });
    await header.selectSubItem(custom);
    expect(manager.reinstall).toHaveBeenCalledOnceWith(partitionId, { forceClose: true });
    expect(header.uiService.openToolWindow).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale catalog and then installs the newly discovered partition app', async () => {
    catalog.next({ loading: false, apps: [] });
    manager.refresh.and.callFake(async () => publish(false));
    await header.selectSubItem(custom);
    expect(manager.refresh).toHaveBeenCalledOnceWith(true);
    expect(manager.install).toHaveBeenCalledOnceWith(partitionId);
    expect(header.uiService.openToolWindow).toHaveBeenCalledTimes(1);
  });

  it('reports a missing catalog entry without opening the removed built-in window', async () => {
    catalog.next({ loading: false, apps: [] });
    await header.selectSubItem(custom);
    expect(manager.refresh).toHaveBeenCalledOnceWith(true);
    expect(manager.install).not.toHaveBeenCalled();
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
    expect(header.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/not available.*重试/), jasmine.any(Object));
  });

  it('waits for unfinished uninstall cleanup instead of opening or installing over it', async () => {
    publish(false, { uninstalling: true });
    await header.selectSubItem(custom);
    expect(manager.install).not.toHaveBeenCalled();
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
    expect(header.message.error).toHaveBeenCalled();
  });

  it('does not open for a different project after installation finishes', async () => {
    const install = holdInstall();
    const opening = header.selectSubItem(custom);
    await install.installing;
    header.projectService.currentProjectPath = '/another-project';
    install.finish();
    await opening;
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
    expect(header.message.remove).toHaveBeenCalledOnceWith('install-notice');
  });

  it('clears progress on destruction and ignores late completion', async () => {
    const install = holdInstall();
    const opening = header.selectSubItem(custom);
    await install.installing;
    header.ngOnDestroy();
    const notices = header.message.loading.calls.count();
    progress.next({ id: partitionId, action: 'install', phase: 'download', percent: 90 });
    expect(header.message.loading.calls.count()).toBe(notices);
    expect(header.message.remove).toHaveBeenCalledOnceWith('install-notice');
    install.finish();
    await opening;
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
  });

  it('reports an unavailable child entry without falling back to the removed window', async () => {
    publish(true);
    header.uiService.openToolWindow.and.returnValue(false);
    await header.selectSubItem(custom);
    expect(header.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/子应用入口不可用/), jasmine.any(Object));
  });

  it('does not install or open a disabled selection or a selection without a project', async () => {
    await header.selectSubItem({ ...custom, disabled: true });
    header.projectService.currentProjectPath = '';
    await header.selectSubItem(custom);
    expect(manager.install).not.toHaveBeenCalled();
    expect(header.uiService.openToolWindow).not.toHaveBeenCalled();
  });
});

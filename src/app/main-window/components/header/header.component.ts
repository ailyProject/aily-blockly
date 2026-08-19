import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, isDevMode, NgZone, OnDestroy, OnInit, ViewChild, viewChild } from '@angular/core';
import { HEADER_BTNS, HEADER_MENU } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../../services/project.service';
import { UiService } from '../../../services/ui.service';
import { BuilderService } from '../../../services/builder.service';
import { UploaderService } from '../../../services/uploader.service';
import { MenuComponent } from '../../../components/menu/menu.component';
import { PortItem, SerialService } from '../../../services/serial.service';
import { ActBtnComponent } from '../act-btn/act-btn.component';
import { IMenuItem } from '../../../configs/menu.config';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { UnsaveDialogComponent } from '../unsave-dialog/unsave-dialog.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UpdateService } from '../../../services/update.service';
import { Router } from '@angular/router';
import { ElectronService } from '../../../services/electron.service';
import { ConfigService } from '../../../services/config.service';
import { AuthService } from '../../../services/auth.service';
import { PlatformService } from '../../../services/platform.service';
import { ProbeRsService } from '../../../services/probe-rs.service';
import { AppItem } from '../../../configs/tool.config';
import { AppStoreService } from '../../../tools/app-store/app-store.service';
import { Subscription } from 'rxjs';
import { BleOtaDeviceItem, UploaderBleService } from '../../../services/uploader-ble.service';
import { ToolI18nService } from '../../../services/tool-i18n.service';
import { CmdOutput, CmdService } from '../../../services/cmd.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import {
  UiAutomationRegistryService,
  type UiAutomationCommandResult,
  type UiAutomationMenuItem,
  type UiAutomationMenuListOptions,
} from '../../../services/ui-automation-registry.service';
import {
  HOST_EXIT_REQUIRES_USER_REASON,
  mainMenuAutomationRejection,
} from '../../../services/main-menu-automation-policy';
import {
  persistBoardConfigSelection,
  shouldRunBoardConfigSelectionEffects,
} from './board-config-selection';
import { hasLinkUploadParam } from '../../../services/debugger-upload-policy';
import { selectSerialPort } from '../../../services/serial-port-selection';

interface NetworkOtaTarget {
  id: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  uploadPath: string;
  ssl?: boolean;
  timeoutMs?: number;
}

@Component({
  selector: 'app-header',
  imports: [
    CommonModule,
    NzToolTipModule,
    MenuComponent,
    ActBtnComponent,
    TranslateModule
  ],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnInit, OnDestroy {
  headerBtns = HEADER_BTNS;
  headerMenu = HEADER_MENU;
  headerApps: AppItem[] = [];

  get isMac() {
    return this.platformService.isMac();
  }

  private _isWindowFullScreen = false;

  get isWindowFullScreen() {
    return this._isWindowFullScreen;
  }

  isMacFullScreen = false;
  private unsubscribeFullScreenChanged?: () => void;
  private unsubscribeMaximizeChanged?: () => void;
  private unsubscribeCloseRequest?: () => void;
  private bleDevicesSubscription?: Subscription;
  private appStoreSubscription?: Subscription;
  private boardChangeSubscription?: Subscription;
  private blePortListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private networkOtaDiscoveredTargets: NetworkOtaTarget[] = [];
  private networkOtaScanInProgress = false;
  private networkOtaScanCancelled = false;
  private networkOtaScanStreamId: string | null = null;
  private unsaveDialogOpen = false; // 标记未保存对话框是否已打开
  private selectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unregisterHeaderMenuAutomation: (() => void) | null = null;

  get projectData() {
    return this.projectService.currentPackageData || { path: '', name: '' };
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  get terminalIsOpen() {
    return this.uiService.terminalIsOpen;
  }

  get currentPort() {
    if (this.serialService.currentPortInfo?.type === 'ble'
      || this.serialService.currentPortInfo?.type === 'network-ota') {
      return this.serialService.currentPortInfo?.text || this.serialService.currentPort;
    }
    return this.serialService.currentPort;
  }

  set currentPort(port) {
    this.serialService.currentPort = port;
  }

  get currentBoard() {
    return this.projectService.currentBoardConfig?.name;
  }

  currentUrl = null;

  get isDevMode() {
    return isDevMode()
  }

  constructor(
    private projectService: ProjectService,
    private uiService: UiService,
    private builderService: BuilderService,
    private uploaderService: UploaderService,
    private serialService: SerialService,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private modal: NzModalService,
    private updateService: UpdateService,
    private router: Router,
    private electronService: ElectronService,
    private configService: ConfigService,
    private authService: AuthService,
    private translate: TranslateService,
    private platformService: PlatformService,
    private probeRsService: ProbeRsService,
    private uploaderBleService: UploaderBleService,
    private ngZone: NgZone,
    private appStoreService: AppStoreService,
    private toolI18n: ToolI18nService,
    private cmdService: CmdService,
    private blocklyService: BlocklyService,
    private uiAutomationRegistry: UiAutomationRegistryService,
  ) { }

  ngOnInit(): void {
    void this.toolI18n.load('serial-monitor');

    this.unregisterHeaderMenuAutomation = this.uiAutomationRegistry.registerMenuProvider('header', {
      list: (options) => this.createHeaderMenuAutomationSnapshot(options).items,
      execute: (itemId, options) => this.executeHeaderMenuAutomationItem(itemId, options),
    });

    this.refreshHeaderApps();
    this.appStoreSubscription = this.appStoreService.layout$.subscribe(() => {
      this.refreshHeaderApps();
      setTimeout(() => this.cd.detectChanges(), 0);
    });
    this.boardChangeSubscription = this.projectService.boardChangeSubject.subscribe(() => {
      void this.resetDebuggerSelectionAfterBoardChange();
    });
  }

  async ngAfterViewInit() {
    this.bleDevicesSubscription = this.uploaderBleService.scanStateChanged.subscribe((state) => {
      //console.log('[BLE:header] scan state changed', state);
      this.ngZone.run(() => {
        this.scheduleBlePortListRefresh();
      });
    });

    if (this.electronService.isElectron) {
      // 初始化窗口最大化状态缓存
      this._isWindowFullScreen = this.electronService.isWindowFullScreen();

      // 监听窗口全屏状态变化
      this.unsubscribeFullScreenChanged = this.electronService.onWindowFullScreenChanged((isFullScreen: boolean) => {
        this.isMacFullScreen = isFullScreen;
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
        }, 0);
      });

      // 监听窗口最大化状态变化（用于更新图标）
      this.unsubscribeMaximizeChanged = this.electronService.onWindowMaximizeChanged((isMaximized: boolean) => {
        this._isWindowFullScreen = isMaximized;
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
        }, 0);
      });

      // Mac 平台下监听系统关闭按钮的关闭请求
      if (this.isMac && window['iWindow'] && window['iWindow'].onCloseRequest) {
        this.unsubscribeCloseRequest = window['iWindow'].onCloseRequest(async () => {
          const canClose = await this.checkUnsavedChanges('close');
          if (canClose) {
            window['iWindow'].confirmClose();
          }
        });
      }
    }

    this.projectService.stateSubject.subscribe((state) => {
      if (state == 'loaded' || state == 'saved') {
        // 将headerMenu中有disabled的按钮置为可用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled) {
            menu.disabled = false;
          }
        });

        // headerBtns中的按钮都置为默认状态
        // this.headerBtns.forEach((btnGroup) => {
        //   btnGroup.forEach((btn) => {
        //     btn.state = 'default';
        //   });
        // });
      } else {
        // 将headerMenu中有disabled的按钮置禁用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled === false) {
            menu.disabled = true;
          }
        });
      }
      // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
      setTimeout(() => {
        this.cd.detectChanges();
      }, 0);
    });

    this.listenShortcutKeys();

    this.authService.showUser.subscribe(state => {
      this.showUser = state;
      // 使用 setTimeout 将变更检测推迟到下一个变更检测周期
      setTimeout(() => {
        this.cd.markForCheck();
      }, 0);
    })
    this.checkAndSetDefaultPort();
  }

  // 检查串口列表并设置默认串口
  private async checkAndSetDefaultPort() {
    try {
      const ports = await this.serialService.getSerialPorts();
      if (ports && ports.length === 1 && !this.currentPort) {
        // 只有一个串口且当前没有选择串口时，设为默认
        this.currentPort = ports[0].name;
        this.serialService.currentPortInfo = {
          name: ports[0].name,
          text: ports[0].text,
          type: ports[0].type,
          icon: ports[0].icon,
        };
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
        }, 0);
      }
    } catch (error) {
      console.warn('获取串口列表失败:', error);
    }
  }

  private async resetDebuggerSelectionAfterBoardChange(): Promise<void> {
    // Invalidate an in-flight probe scan and never carry probe cache across boards.
    this.portListGeneration += 1;
    this.cachedDebuggerItems = [];

    if (this.serialService.currentPortInfo?.type === 'debugger') {
      this.serialService.currentPort = null;
      this.serialService.currentPortInfo = null;

      try {
        const ports = await this.serialService.getSerialPorts();
        const selection = selectSerialPort(ports, {
          boardConfig: this.projectService.currentBoardConfig,
        });
        if (selection.selected?.name) {
          this.serialService.currentPort = selection.selected.name;
          this.serialService.currentPortInfo = {
            ...selection.selected,
            type: selection.selected.type || 'serial',
          };
        }
      } catch (error) {
        console.warn('Failed to select the default serial port after board change:', error);
      }
    }

    if (this.showPortList) {
      await this.getDevicePortList();
    }
    this.cd.detectChanges();
  }

  showMenu = false;
  openMenu() {
    this.showMenu = !this.showMenu;
    // 展开主菜单时刷新「最近的项目」二级列表（来自配置中的 recentlyProjects）
    if (this.showMenu) {
      this.refreshHeaderRecentProjectsMenu();
    }
  }

  /** 同步左上角菜单中「最近的项目」子项 */
  private refreshHeaderRecentProjectsMenu(): void {
    const entry = this.headerMenu.find((m) => m.action === 'recent-projects-root');
    if (!entry) {
      return;
    }
    const recent = this.projectService.recentlyProjects || [];
    entry.children =
      recent.length > 0
        ? recent.map((p: { name?: string; nickname?: string; path: string }) => ({
            name: p.nickname || p.name || p.path,
            text: p.path,
            action: 'recent-project-open',
            data: { path: p.path },
          }))
        : [
            {
              name: this.translate.instant('MENU.RECENT_PROJECTS_EMPTY'),
              disabled: true,
              action: 'noop',
            },
          ];
  }

  private createHeaderMenuAutomationSnapshot(options: UiAutomationMenuListOptions = {}): {
    items: UiAutomationMenuItem[];
    sourceById: Map<string, IMenuItem>;
  } {
    this.refreshHeaderRecentProjectsMenu();
    const sourceById = new Map<string, IMenuItem>();

    const serialize = (items: readonly IMenuItem[], parentId: string): UiAutomationMenuItem[] => {
      const output: UiAutomationMenuItem[] = [];
      items.forEach((item, index) => {
        if (item.sep) return;
        const visible = !!item.children?.length || item.action === 'recent-projects-root' || this.showInRouter(item);
        if (!visible && options.includeHidden !== true) return;

        const identity = this.headerMenuAutomationIdentity(item, index);
        const id = parentId ? `${parentId}/${identity}` : identity;
        const children = item.children?.length ? serialize(item.children, id) : [];
        const entry: UiAutomationMenuItem = {
          id,
          label: this.translate.instant(item.name || item.action || id),
          ...(item.name ? { labelKey: item.name } : {}),
          ...(item.action ? { action: item.action } : {}),
          ...(item.text ? { shortcut: item.text } : {}),
          ...(item.icon ? { icon: item.icon } : {}),
          enabled: item.disabled !== true,
          visible,
          dangerous: item.action === 'app-exit',
          automationBlocked: item.action === 'app-exit',
          ...(item.action === 'app-exit'
            ? { automationBlockedReason: HOST_EXIT_REQUIRES_USER_REASON }
            : {}),
          mayPrompt: ['project-new', 'project-open', 'recent-project-open', 'project-close']
            .includes(item.action || ''),
          ...(children.length ? { children } : {}),
        };
        sourceById.set(id, item);
        output.push(entry);
      });
      return output;
    };

    return { items: serialize(this.headerMenu, 'header'), sourceById };
  }

  private async executeHeaderMenuAutomationItem(
    itemId: string,
    _options: { confirm?: boolean } = {},
  ): Promise<UiAutomationCommandResult> {
    const snapshot = this.createHeaderMenuAutomationSnapshot({ includeHidden: true });
    const item = snapshot.sourceById.get(String(itemId || '').trim());
    if (!item) {
      return { ok: false, message: `未找到菜单项: ${itemId}；请重新调用 main_menu_list 获取当前 ID。` };
    }
    if (!this.showInRouter(item) && !item.children?.length && item.action !== 'recent-projects-root') {
      return { ok: false, message: `菜单项在当前界面不可用: ${itemId}` };
    }
    if (item.disabled) {
      return { ok: false, message: `菜单项当前已禁用: ${itemId}` };
    }
    if (item.children?.length || item.action === 'recent-projects-root') {
      return { ok: false, message: `菜单项 ${itemId} 是分组，请选择其 children 中的具体 itemId。` };
    }
    const policyRejection = mainMenuAutomationRejection(item.action, itemId);
    if (policyRejection) {
      return policyRejection;
    }

    if (item.action === 'recent-project-open') {
      await this.onHeaderMenuSubItemClick(item);
    } else {
      await this.process(item);
    }
    return {
      ok: true,
      operation: 'main_menu_execute',
      itemId,
      action: item.action || null,
      message: `已执行菜单项: ${this.translate.instant(item.name || item.action || itemId)}`,
    };
  }

  private headerMenuAutomationIdentity(item: IMenuItem, index: number): string {
    const action = String(item.action || item.key || item.name || `item-${index}`).trim();
    const contextualValue = item.action === 'recent-project-open' && typeof item.data?.path === 'string'
      ? `:${encodeURIComponent(item.data.path)}`
      : '';
    return `${encodeURIComponent(action)}${contextualValue}~${index}`;
  }

  /** 主菜单二级项：打开最近项目 */
  async onHeaderMenuSubItemClick(subItem: IMenuItem) {
    if (subItem.disabled || subItem.action === 'noop') {
      return;
    }
    if (subItem.action === 'recent-project-open') {
      const path = subItem.data?.path as string | undefined;
      if (!path) {
        return;
      }
      if (this.isLoaded()) {
        const canContinue = await this.checkUnsavedChanges('open');
        if (!canContinue) {
          return;
        }
      }
      await this.projectService.projectOpen(path);
      this.closeMenu();
    }
  }

  closeMenu() {
    this.showMenu = false;
  }

  showPortList = false;
  configList: PortItem[] = []
  boardKeywords = [];
  private cachedDebuggerItems: IMenuItem[] = [];
  private portListGeneration = 0; // 这个用来高亮显示正确开发板，如['arduino uno']，则端口菜单中如有包含'arduino uno'的串口则高亮显示

  /**
   * 异步检测调试探针，完成后更新缓存并重建端口列表
   */
  private detectProbes(generation: number, portList: IMenuItem[], skipDetect: boolean) {

    // console.log('detectProbes');

    if (!skipDetect) {
      if (this.cachedDebuggerItems.length > 0) {
        portList.push(...this.cachedDebuggerItems);
      }
      this.probeRsService.listProbes().then(result => {
        if (generation !== this.portListGeneration) return;
        const newDebuggerItems: IMenuItem[] = [];
        if (result.success && result.probes && result.probes.length > 0) {
          newDebuggerItems.push({ sep: true });
          for (const probe of result.probes) {
            console.log('Detected probe:', probe);
            const typeName = probe.type || probe.name || 'Unknown';
            newDebuggerItems.push({
              name: typeName,
              text: probe.shortSerial || '',
              type: 'debugger',
              icon: 'fa-brands fa-usb',
              extra: { vidPid: probe.vidPid, serial: probe.serial },
            });
          }
        }
        if (JSON.stringify(newDebuggerItems) !== JSON.stringify(this.cachedDebuggerItems)) {
          this.cachedDebuggerItems = newDebuggerItems;
          this.getDevicePortList(true);
        }
      }).catch(e => {
        console.warn('调试探针检测失败:', e);
      });
    } else if (this.cachedDebuggerItems.length > 0) {
      portList.push(...this.cachedDebuggerItems);
    }
  }
  openPortList(event?: MouseEvent) {
    if (event) {
      this.calculatePortListPosition(event);
    } else {
      // 快捷键触发时，查找上传按钮元素获取位置
      const uploadBtn = document.querySelector('[data-action="upload"]') as HTMLElement;
      if (uploadBtn) {
        const rect = uploadBtn.getBoundingClientRect();
        this.portListPosition = {
          x: rect.left + 2,
          y: 40
        };
      } else {
        // 备用位置
        this.portListPosition = { x: 40, y: 40 };
      }
    }
    // Aily Code 在 npm 主板包就绪前可能尚无 currentBoardConfig
    const boardLabel = this.currentBoard ?? '';
    const boardname = boardLabel.replace(' 2560', ' ').replace(' R3', '');
    this.boardKeywords = boardname ? [boardname] : [];
    // 如果已有缓存列表，先展示旧数据，再后台刷新
    this.showPortList = true;
    this.getDevicePortList();
  }

  closePortList() {
    if (this.uploaderBleService.isScanning() || this.uploaderBleService.hasActiveRequest()) {
      this.uploaderBleService.cancelScan();
    }
    if (this.networkOtaScanInProgress && this.networkOtaScanStreamId) {
      this.networkOtaScanCancelled = true;
      this.cmdService.kill(this.networkOtaScanStreamId);
      this.networkOtaScanStreamId = null;
      this.networkOtaScanInProgress = false;
    }
    this.showPortList = false;
    // this.cd.detectChanges();
  }

  async selectPort(item) {
    if (item.action) {
      this.process(item)
      return
    }

    if (item.type === 'ble') {
      try {
        const device = await this.uploaderBleService.selectDevice(item.extra?.deviceId || item.name);
        item = {
          ...item,
          name: device.id,
          text: device.name,
          icon: item.icon || 'fa-brands fa-bluetooth-b',
          extra: {
            ...(item.extra || {}),
            deviceId: device.id,
          }
        };
      } catch (error) {
        this.message.error(error?.message || '选择 BLE 设备失败');
        return;
      }
    }

    if (item.type === 'network-ota') {
      const target = this.normalizeNetworkOtaTarget(item.extra?.target);
      if (!target) {
        this.message.error(this.translate.instant('NETWORK_OTA.INVALID_HOST'));
        return;
      }
      this.selectNetworkOtaTarget(target);
      return;
    }

    this.serialService.currentPort = item.name;
    this.serialService.currentPortInfo = {
      name: item.name,
      text: item.text,
      type: item.type,
      icon: item.icon,
      probeSerial: item.extra?.serial || '',
      probeVidPid: item.extra?.vidPid || '',
      extra: item.extra,
    };
    this.closePortList();
  }

  async getDevicePortList(skipDetect = false) {
    const generation = ++this.portListGeneration;
    let portList0: IMenuItem[] = await this.serialService.getSerialPorts();
    let hasSelectablePort = portList0.length > 0;

    let core = (this.projectService.currentBoardConfig?.['core'] || '').toLowerCase();
    const canShowBleOtaPorts = await this.canShowBleOtaPorts(core);
    const canShowNetworkOtaPorts = await this.canShowNetworkOtaPorts(core);

    if (canShowBleOtaPorts) {
      const bleItems = this.uploaderBleService.getPortMenuItems(this.serialService.currentPort);
      //console.log('[BLE:header] getDevicePortList BLE items', bleItems.length, bleItems);
      if (bleItems.length > 0) {
        if (portList0.length > 0) {
          portList0.push({ sep: true });
        }
        portList0 = portList0.concat(bleItems);
        hasSelectablePort = true;
      }
    }

    if (canShowNetworkOtaPorts) {
      const networkOtaItems = await this.getNetworkOtaPortMenuItems(this.serialService.currentPort);
      if (networkOtaItems.length > 0) {
        if (portList0.length > 0) {
          portList0.push({ sep: true });
        }
        portList0 = portList0.concat(networkOtaItems);
        hasSelectablePort = true;
      }
    }

    if (!hasSelectablePort) {
      portList0 = [
        {
          name: 'Device not found',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-triangle-exclamation',
          disabled: true,
        }
      ];
    }

    // 加载当前开发板包声明的可选配置菜单。
    if (hasLinkUploadParam(this.projectService.currentBoardConfig)) {
      this.detectProbes(generation, portList0, skipDetect);
    } else {
      this.cachedDebuggerItems = [];
    }

    const boardConfigMenu = await this.projectService.getBoardConfigMenu();
    if (boardConfigMenu.length > 0) {
      portList0 = portList0.concat(boardConfigMenu);
    }

    // Add the board switch entry after optional package-provided menu items.
    portList0.push({ sep: true });
    portList0.push({
      name: this.translate.instant('BOARD_SELECTOR.TITLE'),
      icon: 'fa-light fa-layer-group',
      action: 'board-select',
      // children: boardList
    })
    this.configList = portList0;
    // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.cd.detectChanges();
    }, 0);
  }

  private isEsp32Core(core = (this.projectService.currentBoardConfig?.['core'] || '').toLowerCase()): boolean {
    return core === 'esp32' || core.startsWith('esp32:');
  }

  private async canShowBleOtaPorts(core = (this.projectService.currentBoardConfig?.['core'] || '').toLowerCase()): Promise<boolean> {
    return this.isEsp32Core(core) && await this.hasProjectDependency('@aily-project/lib-bleota');
  }

  private async canShowNetworkOtaPorts(core = (this.projectService.currentBoardConfig?.['core'] || '').toLowerCase()): Promise<boolean> {
    return this.isEsp32Core(core) && await this.hasProjectDependency('@aily-project/lib-wifiota');
  }

  private async getNetworkOtaPortMenuItems(currentPort?: string): Promise<IMenuItem[]> {
    const savedTargets = await this.getNetworkOtaTargets();
    const targets = this.mergeNetworkOtaTargets(savedTargets, this.networkOtaDiscoveredTargets);
    const items: IMenuItem[] = [{
      name: this.translate.instant(this.networkOtaScanInProgress ? 'NETWORK_OTA.SEARCHING_DEVICE' : 'NETWORK_OTA.SEARCH_DEVICE'),
      action: 'network-ota-scan',
      type: 'network-ota-action',
      icon: this.networkOtaScanInProgress ? 'fa-light fa-spinner fa-spin' : 'fa-light fa-magnifying-glass',
      disabled: this.networkOtaScanInProgress,
    }];

    for (const target of targets) {
      items.push({
        name: target.name || this.translate.instant('NETWORK_OTA.DEFAULT_TARGET_NAME'),
        text: `${target.host}:${target.port}`,
        type: 'network-ota',
        icon: 'fa-light fa-wifi',
        current: currentPort === target.id,
        extra: { target },
      });
    }

    return items;
  }

  private mergeNetworkOtaTargets(...targetGroups: NetworkOtaTarget[][]): NetworkOtaTarget[] {
    const targetMap = new Map<string, NetworkOtaTarget>();

    for (const targetGroup of targetGroups) {
      for (const target of targetGroup || []) {
        const normalized = this.normalizeNetworkOtaTarget(target);
        if (!normalized) continue;

        const key = `${normalized.host}:${normalized.port}:${normalized.uploadPath}`;
        if (!targetMap.has(key)) {
          targetMap.set(key, normalized);
        }
      }
    }

    return Array.from(targetMap.values());
  }

  private async getNetworkOtaTargets(): Promise<NetworkOtaTarget[]> {
    try {
      const packageJson = await this.projectService.getPackageJson();
      const targets = packageJson?.projectConfig?.networkOtaTargets;
      if (!Array.isArray(targets)) return [];

      return targets
        .map((target: any) => this.normalizeNetworkOtaTarget(target))
        .filter((target: NetworkOtaTarget | null): target is NetworkOtaTarget => !!target);
    } catch (error) {
      console.warn('读取 WiFi OTA 目标失败:', error);
      return [];
    }
  }

  private normalizeNetworkOtaTarget(target: any): NetworkOtaTarget | null {
    const host = (target?.host || '').toString().trim();
    const port = Number(target?.port || 65280);
    const uploadPath = (target?.uploadPath || '/sketch').toString().trim();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

    const normalizedUploadPath = uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`;
    return {
      id: target?.id || `network-ota:${host}:${port}:${normalizedUploadPath}`,
      name: (target?.name || '').toString().trim(),
      host,
      port,
      username: (target?.username || 'arduino').toString(),
      password: (target?.password || 'password').toString(),
      uploadPath: normalizedUploadPath,
      ssl: !!target?.ssl,
      timeoutMs: Math.max(1000, Number(target?.timeoutMs || 60000)),
    };
  }

  private selectNetworkOtaTarget(target: NetworkOtaTarget): void {
    this.serialService.currentPort = target.id;
    this.serialService.currentPortInfo = {
      name: target.id,
      text: target.name || `${target.host}:${target.port}`,
      type: 'network-ota',
      icon: 'fa-light fa-wifi',
      extra: { target },
    };
    this.closePortList();
  }

  private async hasProjectDependency(dependencyName: string): Promise<boolean> {
    try {
      const packageJson = await this.projectService.getPackageJson();
      const dependencies = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
        ...(packageJson?.peerDependencies || {}),
      };

      return Object.prototype.hasOwnProperty.call(dependencies, dependencyName);
    } catch (error) {
      console.warn('读取项目依赖失败:', error);
      return false;
    }
  }

  onClick(item, event = null) {
    this.process(item, event);
  }

  isOpenTool(btn) {
    if (btn.data.type == 'terminal') {
      return this.terminalIsOpen;
    } else if (btn.data && btn.data.data) {
      return this.uiService.isToolOpen(btn.data.data);
    }
    return false;
  }

  onMenuClick(item) {
    if (item.disabled) return;
    this.process(item);
    this.closeMenu();
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: this.projectData.path,
    });
    // console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async selectSaveAsFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      path: this.projectData.path,
      suggestedName: this.projectData.name + '_new',
    });
    // console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async openProject() {
    const path = await this.selectFolder();
    if (path) {
      await this.projectService.projectOpen(path);
    }
  }

  updateSubscription: any = null;
  private workspaceImageExporting = false;

  async process(item: IMenuItem, event = null) {
    switch (item.action) {
      case 'project-new':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('new');
          if (!canContinue) return;
        }
        this.uiService.openWindow(item.data);
        break;
      case 'project-open':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('open');
          if (!canContinue) return;
        }
        this.openProject();
        break;
      case 'project-save':
        this.projectService.save();
        break;
      case 'project-save-as':
        const path = await this.selectSaveAsFolder();
        if (path) {
          await this.projectService.saveAs(path);
        }
        break;
      case 'workspace-export-image':
        await this.exportWorkspaceImage();
        break;
      case 'project-close':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('close');
          if (!canContinue) return;
        }
        this.projectService.close();
        break;
      case 'project-open-by-explorer':
        window['other'].openByExplorer(this.projectService.currentProjectPath);
        break;
      case 'tool-open':
        this.uiService.turnTool(item.data);
        break;
      case 'ble-scan':
        this.startBleScan();
        break;
      case 'network-ota-scan':
        this.startNetworkOtaMdnsSearch();
        break;
      // case 'terminal':
      //   this.uiService.turnTerminal(item.data);
      //   break;
      case 'compile':
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.builderService.build().then(result => {
          item.state = result.state || 'done';
        }).catch(err => {
          // console.log("编译未完成: ", JSON.stringify(err));
          item.state = this.resolveActionErrorState(err, ['buildResult']);
        })
        break;
      case 'upload':
        // 确认是否选择串口
        if (!this.serialService.currentPort) {
          this.message.warning(this.translate.instant('SERIAL.SELECT_PORT_FIRST'));
          this.openPortList(event);
          return;
        }
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.uploaderService.upload().then(result => {
          item.state = result.state || 'done';
        }).catch(err => {
          // console.log("上传未完成: ", JSON.stringify(err));
          item.state = this.resolveActionErrorState(err, ['result']);
        });
        break;
      case 'settings-open':
        this.uiService.openWindow(item.data);
        break;
      case 'check-update':
        this.updateService.clearSkipVersions();
        if (!this.updateSubscription) {
          this.updateSubscription = this.updateService.updateStatus.subscribe((status) => {
            // console.log('更新状态:', status);
            if (status === 'not-available') {
              this.message.info('当前已是最新版本');
            }
          });
        }
        this.updateService.checkForUpdates(true);
        break;
      case 'browser-open':
        this.electronService.openUrl(item.data.url);
        break;
      case 'app-exit':
        await this.close();
        break;
      case 'example-open':
        if (this.isLoaded()) { // 只在已加载项目时检查
          this.electronService.openNewInStance('/main/playground')
        } else {
          this.router.navigate(['/main/playground']);
        }
        break;
      case 'board-select':
        this.openBoardSelectorDialog();
        break;
      case 'feedback':
        this.uiService.openFeedback();
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  private async exportWorkspaceImage(): Promise<void> {
    if (this.workspaceImageExporting) {
      return;
    }

    this.workspaceImageExporting = true;
    try {
      const workspaceSvg = await this.blocklyService.createWorkspaceImageExportSvg();
      if (!workspaceSvg) {
        this.message.warning(this.translate.instant('MENU.IMAGE_EXPORT_EMPTY'));
        return;
      }

      const filePath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
        suggestedName: this.getWorkspaceSvgExportFilename(),
        title: this.translate.instant('MENU.IMAGE_EXPORT'),
        filters: [
          { name: 'SVG 文件', extensions: ['svg'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (!filePath) {
        return;
      }

      window['fs'].writeFileSync(this.ensureSvgFileExtension(filePath), workspaceSvg);
      this.message.success(this.translate.instant('MENU.IMAGE_EXPORT_SUCCESS'));
    } catch (error) {
      console.error('Export Blockly workspace image failed:', error);
      this.message.error(this.translate.instant('MENU.IMAGE_EXPORT_FAILED'));
    } finally {
      this.workspaceImageExporting = false;
    }
  }

  private getWorkspaceSvgExportFilename(): string {
    const projectName = String(this.projectData.name || 'blockly-workspace')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    return `${projectName || 'blockly-workspace'}.svg`;
  }

  private ensureSvgFileExtension(filePath: string): string {
    if (/\.svg$/i.test(filePath)) {
      return filePath;
    }

    return `${filePath}.svg`;
  }

  private resolveActionErrorState(err: any, nestedKeys: string[] = []): RunState['state'] {
    const directState = err?.state;
    if (this.isFailureRunState(directState)) {
      return directState;
    }

    for (const key of nestedKeys) {
      const nestedState = err?.[key]?.state;
      if (this.isFailureRunState(nestedState)) {
        return nestedState;
      }
    }

    return 'error';
  }

  private isFailureRunState(state: any): state is Extract<RunState['state'], 'error' | 'warn'> {
    return state === 'error' || state === 'warn';
  }

  minimize() {
    window['iWindow'].minimize();
  }

  maximize() {
    if (window['iWindow'].isMaximized()) {
      window['iWindow'].unmaximize();
    } else {
      window['iWindow'].maximize();
    }
    // 立即更新缓存状态，避免 UI 延迟
    this._isWindowFullScreen = window['iWindow'].isMaximized();
  }

  ngOnDestroy() {
    this.unregisterHeaderMenuAutomation?.();
    this.unregisterHeaderMenuAutomation = null;
    this.appStoreSubscription?.unsubscribe();
    this.boardChangeSubscription?.unsubscribe();
    if (this.bleDevicesSubscription) {
      this.bleDevicesSubscription.unsubscribe();
    }
    if (this.blePortListRefreshTimer) {
      clearTimeout(this.blePortListRefreshTimer);
      this.blePortListRefreshTimer = null;
    }
    if (this.networkOtaScanStreamId) {
      this.networkOtaScanCancelled = true;
      this.cmdService.kill(this.networkOtaScanStreamId);
      this.networkOtaScanStreamId = null;
    }
    if (this.electronService.isElectron) {
      // 取消窗口全屏状态变化监听
      if (this.unsubscribeFullScreenChanged) {
        this.unsubscribeFullScreenChanged();
      }
      // 取消窗口最大化状态变化监听
      if (this.unsubscribeMaximizeChanged) {
        this.unsubscribeMaximizeChanged();
      }
      // 取消 Mac 平台关闭请求监听
      if (this.unsubscribeCloseRequest) {
        this.unsubscribeCloseRequest();
      }
    }
  }

  async close(): Promise<boolean> {
    const canClose = await this.checkUnsavedChanges('close');
    if (!canClose) {
      return false;
    }
    window['iWindow'].close();
    return true;
  }

  // 快捷键功能，监听键盘事件,执行对应的操作
  private shortcutMap: Map<string, IMenuItem> = new Map();
  private initShortcutMap(): void {
    // 处理 HEADER_MENU 的快捷键
    for (const item of HEADER_MENU) {
      if (item.text) {
        // 将快捷键文本转换成标准格式(如: "ctrl+s")
        const shortcutKey = this.normalizeShortcutKey(item.text);
        if (shortcutKey) {
          this.shortcutMap.set(shortcutKey, item);
        }
      }
    }
    // 处理 HEADER_BTNS 的快捷键（编译、上传等）
    for (const item of HEADER_BTNS) {
      if (item.text) {
        const shortcutKey = this.normalizeShortcutKey(item.text);
        if (shortcutKey) {
          this.shortcutMap.set(shortcutKey, item);
        }
      }
    }
    // console.log('已初始化快捷键映射:', Array.from(this.shortcutMap.keys()));
  }

  // 转换快捷键文本为标准格式（Ctrl/⌘ 统一为 ctrl）
  private normalizeShortcutKey(shortcutText: string): string {
    if (!shortcutText) return '';

    return shortcutText.toLowerCase()
      .replace(/ctrl\/⌘|⌘/g, 'ctrl')  // Mac Command 与 Ctrl 等效
      .split('+')
      .map(part => part.trim())
      .filter(part => part)
      .sort((a, b) => {
        // 保证修饰键的顺序：ctrl 在前，shift 在后，其他按字母顺序
        if (a === 'ctrl') return -1;
        if (b === 'ctrl') return 1;
        if (a === 'shift') return -1;
        if (b === 'shift') return 1;
        return a.localeCompare(b);
      })
      .join('+');
  }

  // 从键盘事件生成标准化的快捷键字符串（Mac Command 与 Ctrl 等效）
  private getShortcutFromEvent(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    // 添加主键，忽略修饰键本身
    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }

  /* 监听快捷键
  */
  listenShortcutKeys() {
    this.initShortcutMap();
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      // 处理窗口缩放快捷键（Mac 上 Command 与 Ctrl 等效）
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          this.zoomOut();
          return;
        }
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          this.zoomIn();
          return;
        }
        if (event.key === '0') {
          event.preventDefault();
          this.resetZoom();
          return;
        }
      }

      // 处理功能键 F1-F12
      const isFunctionKey = /^f([1-9]|1[0-2])$/i.test(event.key);

      // 处理包含修饰键的组合键或功能键（含 Mac Command）
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || isFunctionKey) {
        const shortcutKey = this.getShortcutFromEvent(event);
        const menuItem = this.shortcutMap.get(shortcutKey);

        if (menuItem && this.showInRouter(menuItem)) {
          event.preventDefault(); // 阻止默认行为
          console.log('快捷键触发:', menuItem.name, shortcutKey);

          // 执行对应的操作
          if (menuItem.action) {
            this.process(menuItem);
          }
        }
      }
    });
  }

  // 窗口缩放功能
  private currentZoomLevel = 0; // 0表示100%缩放

  zoomIn() {
    this.currentZoomLevel = Math.min(this.currentZoomLevel + 0.5, 3);
    this.setZoomLevel(this.currentZoomLevel);
  }

  zoomOut() {
    this.currentZoomLevel = Math.max(this.currentZoomLevel - 0.5, -3);
    this.setZoomLevel(this.currentZoomLevel);
  }

  resetZoom() {
    this.currentZoomLevel = 0;
    this.setZoomLevel(this.currentZoomLevel);
  }

  private setZoomLevel(level: number) {
    if (this.electronService.isElectron) {
      // 使用preload中暴露的webFrame API设置缩放级别
      window['webFrame'].setZoomLevel(level);
    } else {
      // 在浏览器中使用CSS transform作为备选方案
      const zoomFactor = Math.pow(1.2, level);
      document.body.style.transform = `scale(${zoomFactor})`;
      document.body.style.transformOrigin = 'top left';
      if (zoomFactor !== 1) {
        document.body.style.width = `${100 / zoomFactor}%`;
        document.body.style.height = `${100 / zoomFactor}%`;
      } else {
        document.body.style.width = '';
        document.body.style.height = '';
      }
    }
  }

  async checkUnsavedChanges(action: 'close' | 'open' | 'new'): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!await this.projectService.hasUnsavedChanges()) {
      return true;
    }

    // 如果弹窗已经打开，直接返回 false，避免重复弹出
    if (this.unsaveDialogOpen) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      // 标记弹窗已打开
      this.unsaveDialogOpen = true;

      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '350px',
        nzContent: UnsaveDialogComponent,
        nzData: { action },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        // 弹窗关闭后重置标志位
        this.unsaveDialogOpen = false;

        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'save':
            // 保存项目并继续
            await this.projectService.save();
            resolve(true);
            break;
          case 'continue':
            // 不保存，但继续操作
            resolve(true);
            break;
          case 'cancel':
          default:
            // 取消操作
            resolve(false);
            break;
        }
      });
    });
  }

  showInRouter(menuItem: IMenuItem) {
    if (!menuItem.router) {
      return true;
    } else {
      for (const router of menuItem.router) {
        if (this.router.url.indexOf(router) > -1) {
          return true;
        }
      }
    }
  }

  showApp(app: AppItem) {
    return this.appStoreService.isAppVisible(app, {
      routeUrl: this.router.url,
      boardCore: this.projectService.currentBoardConfig?.core,
      isDevMode: this.isDevMode
    });
  }

  private refreshHeaderApps(): void {
    this.headerApps = this.appStoreService.getAppsForZone('header');
  }

  private showInCore(app: AppItem) {
    if (!app.core || app.core.length === 0) {
      return true;
    }

    const currentCore = this.getCurrentBoardCore();
    return app.core.some(core => this.matchesAppCore(core, currentCore));
  }

  private getCurrentBoardCore() {
    return String(this.projectService.currentBoardConfig?.core || '').toLowerCase();
  }

  private matchesAppCore(appCore: string, currentCore: string) {
    const normalizedAppCore = appCore.toLowerCase();
    return currentCore === normalizedAppCore || currentCore.split(':').includes(normalizedAppCore);
  }

  // 判断路由是否为 ['/main/blockly-editor', '/main/code-editor', '/main/code-editor-pro']中的一个，如果是返回true
  isLoaded() {
    for (const router of ['/main/blockly-editor', '/main/code-editor', '/main/code-editor-pro']) {
      if (this.router.url.indexOf(router) > -1) {
        return true;
      }
    }
  }

  private async startBleScan() {
    if (!await this.canShowBleOtaPorts()) {
      if (this.showPortList) {
        this.getDevicePortList(true);
      }
      return;
    }

    //console.log('[BLE:header] start scan clicked');
    this.getDevicePortList(true);
    this.uploaderBleService.beginScan().then((device: BleOtaDeviceItem) => {
      //console.log('[BLE:header] scan selected device', device);
      this.selectBleDevice(device);
      if (this.showPortList) {
        this.getDevicePortList(true);
      }
    }).catch(error => {
      const message = error?.message || String(error || '');
      console.warn('[BLE:header] scan failed', error);
      if (message && !/cancel|cancelled|no device selected|user cancelled/i.test(message)) {
        this.message.warning(message);
      }
      if (this.showPortList) {
        this.getDevicePortList(true);
      }
    });
  }

  private scheduleBlePortListRefresh() {
    if (!this.showPortList || this.blePortListRefreshTimer) return;

    this.blePortListRefreshTimer = setTimeout(() => {
      this.blePortListRefreshTimer = null;
      if (this.showPortList) {
        //console.log('[BLE:header] refresh port list after BLE state change');
        this.getDevicePortList(true);
      }
    }, 100);
  }

  private selectBleDevice(device: BleOtaDeviceItem) {
    this.serialService.currentPort = device.id;
    this.serialService.currentPortInfo = {
      name: device.id,
      text: device.name,
      type: 'ble',
      icon: 'fa-brands fa-bluetooth-b',
      extra: { deviceId: device.id },
    };
    this.closePortList();
  }

  private async startNetworkOtaMdnsSearch() {
    if (this.networkOtaScanInProgress) return;
    if (!await this.canShowNetworkOtaPorts()) {
      return;
    }

    this.networkOtaScanInProgress = true;
    this.networkOtaScanCancelled = false;
    this.networkOtaDiscoveredTargets = [];
    if (this.showPortList) {
      this.getDevicePortList(true);
    }

    const searchScriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'network-ota-mdns-search.js');
    const searchCmd = `node "${searchScriptPath}" --timeout 4000`;
    let outputText = '';
    let errorText = '';
    let exitCode = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        this.cmdService.run(searchCmd, null, false, true).subscribe({
          next: (output: CmdOutput) => {
            this.networkOtaScanStreamId = output.streamId;
            if (output.data) {
              outputText += output.data;
            }

            if (output.type === 'error') {
              errorText = output.error || this.translate.instant('NETWORK_OTA.SEARCH_FAILED');
              exitCode = 1;
              return;
            }

            if (output.type === 'close') {
              exitCode = output.code ?? (output.signal ? 1 : 0);
              if (exitCode !== 0 && !errorText) {
                errorText = output.stderr || output.stdout || this.translate.instant('NETWORK_OTA.SEARCH_FAILED');
              }
            }
          },
          error: reject,
          complete: () => resolve(),
        });
      });

      if (this.networkOtaScanCancelled) {
        return;
      }

      if (exitCode !== 0) {
        throw new Error(errorText || this.translate.instant('NETWORK_OTA.SEARCH_FAILED'));
      }

      const discoveredTargets = this.parseNetworkOtaMdnsResult(outputText);
      this.networkOtaDiscoveredTargets = discoveredTargets;

      if (discoveredTargets.length > 0) {
        this.message.success(this.translate.instant('NETWORK_OTA.SEARCH_DONE', { count: discoveredTargets.length }));
      } else {
        this.message.warning(this.translate.instant('NETWORK_OTA.SEARCH_EMPTY'));
      }
    } catch (error) {
      if (!this.networkOtaScanCancelled) {
        this.message.error(error?.message || this.translate.instant('NETWORK_OTA.SEARCH_FAILED'));
      }
    } finally {
      this.networkOtaScanInProgress = false;
      this.networkOtaScanStreamId = null;
      if (this.showPortList) {
        this.getDevicePortList(true);
      }
    }
  }

  private parseNetworkOtaMdnsResult(outputText: string): NetworkOtaTarget[] {
    const resultLine = String(outputText || '')
      .split(/\r\n|\n|\r/)
      .map(line => line.trim())
      .reverse()
      .find(line => line.startsWith('[network-ota-mdns:result]'));

    if (!resultLine) {
      return [];
    }

    const rawJson = resultLine.slice('[network-ota-mdns:result]'.length).trim();
    let targets: any[] = [];
    try {
      targets = JSON.parse(rawJson);
    } catch (error) {
      console.warn('Parse WiFi OTA mDNS result failed:', error);
      return [];
    }

    if (!Array.isArray(targets)) {
      return [];
    }

    return targets
      .map(target => this.normalizeNetworkOtaTarget(target))
      .filter((target: NetworkOtaTarget | null): target is NetworkOtaTarget => !!target);
  }

  private isCustomPartitionSubItem(subItem: IMenuItem): boolean {
    return subItem.key === 'PartitionScheme'
      && String(subItem.data || '').toLowerCase() === 'custom';
  }

  private getCustomPartitionPaths(): { srcDir: string; requiredFilePath: string; legacyFilePath: string } | null {
    const projectRoot = this.projectService.currentProjectPath;
    if (!projectRoot) {
      return null;
    }
    const pathApi = window['path'];
    return {
      srcDir: pathApi.join(projectRoot, 'src'),
      requiredFilePath: pathApi.join(projectRoot, 'src', 'partitions.csv'),
      legacyFilePath: pathApi.join(projectRoot, 'partitions.csv'),
    };
  }

  private fileExists(filePath: string): boolean {
    try {
      return window['fs']?.existsSync?.(filePath) === true;
    } catch {
      return false;
    }
  }

  private normalizeComparablePath(filePath: string): string {
    return String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private copyPartitionFile(sourcePath: string, targetPath: string, srcDir: string): void {
    if (!this.fileExists(srcDir)) {
      window['fs'].mkdirSync(srcDir, { recursive: true });
    }
    if (this.normalizeComparablePath(sourcePath) === this.normalizeComparablePath(targetPath)) {
      return;
    }
    window['fs'].copySync(sourcePath, targetPath);
  }

  private async selectCustomPartitionFile(defaultPath: string): Promise<string> {
    const dialog = (window as any).dialog;
    if (dialog?.selectFiles) {
      const result = await dialog.selectFiles({
        title: '选择 ESP32 分区文件',
        defaultPath,
        properties: ['openFile'],
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return result?.canceled ? '' : String(result?.filePaths?.[0] || '');
    }

    return await window['ipcRenderer'].invoke('select-file', {
      title: '选择 ESP32 分区文件',
      path: defaultPath,
    });
  }

  private async ensureCustomPartitionFileForUserSelection(): Promise<{ ready: boolean; changed: boolean }> {
    const paths = this.getCustomPartitionPaths();
    if (!paths) {
      this.message.error('当前没有打开的项目，无法设置自定义分区');
      return { ready: false, changed: false };
    }

    if (this.fileExists(paths.requiredFilePath)) {
      return { ready: true, changed: false };
    }

    if (this.fileExists(paths.legacyFilePath)) {
      try {
        this.copyPartitionFile(paths.legacyFilePath, paths.requiredFilePath, paths.srcDir);
        this.message.info(`已将分区文件迁移到 ${paths.requiredFilePath}`);
        return { ready: true, changed: true };
      } catch (error) {
        console.warn('迁移分区文件失败:', error);
        this.message.error(`迁移分区文件失败，请手动放置到 ${paths.requiredFilePath}`);
        return { ready: false, changed: false };
      }
    }

    const selectedFilePath = await this.selectCustomPartitionFile(paths.srcDir);
    if (!selectedFilePath) {
      this.message.warning('未选择分区文件，已取消自定义分区设置');
      return { ready: false, changed: false };
    }

    try {
      this.copyPartitionFile(selectedFilePath, paths.requiredFilePath, paths.srcDir);
      return { ready: true, changed: true };
    } catch (error) {
      console.warn('复制分区文件失败:', error);
      this.message.error(`复制分区文件失败，请手动放置到 ${paths.requiredFilePath}`);
      return { ready: false, changed: false };
    }
  }

  // 选择子菜单项-修改编译上传配置
  async selectSubItem(subItem: IMenuItem) {
    // console.log('选择子菜单项:', subItem);
    if (this.selectDebounceTimer !== null) {
      clearTimeout(this.selectDebounceTimer);
    }

    this.selectDebounceTimer = setTimeout(async () => {
      this.selectDebounceTimer = null;

      let customPartitionChanged = false;
      if (this.isCustomPartitionSubItem(subItem)) {
        const partitionResult = await this.ensureCustomPartitionFileForUserSelection();
        if (!partitionResult.ready) {
          return;
        }
        customPartitionChanged = partitionResult.changed;
      }

      const configChanged = await persistBoardConfigSelection(this.projectService, subItem);
      const shouldRunEffects = shouldRunBoardConfigSelectionEffects(
        configChanged || customPartitionChanged,
        subItem,
      );
      if (!shouldRunEffects) {
        return;
      }

      if (subItem.extra?.refreshRuntimeBoardConfig) {
        await this.projectService.refreshRuntimeBoardConfig();
      }

      if (configChanged && subItem.extra?.syncPinConfig) {
        await this.projectService.syncBoardPinConfig(subItem);
      }

      if (subItem.extra?.selectAction === 'flash-softdevice') {
        if (!this.serialService.currentPort) {
          const messageKey = subItem.extra?.selectPortMessage;
          this.message.warning(messageKey ? this.translate.instant(messageKey) : 'Please select a port first');
          return;
        }
        await this.uploaderService.flashSoftdevice(subItem.data, this.serialService.currentPort);
      }

      if (configChanged || customPartitionChanged) {
        this.builderService.triggerPreprocess('config-changed');
      }
    }, 500);
  }

  showUser = false;

  closeUser() {
    this.showUser = false;
  }


  portListPosition = { x: 40, y: 40 };
  calculatePortListPosition(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    // 计算端口列表的位置，使其显示在点击元素的下方
    this.portListPosition = {
      x: rect.left + 2,
      y: 40
    };

    // 确保端口列表不会超出窗口边界
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const portListWidth = 300; // 端口列表的宽度
    const portListHeight = 400; // 端口列表的高度

    if (this.portListPosition.x + portListWidth > windowWidth) {
      this.portListPosition.x = windowWidth - portListWidth - 3;
    }

    if (this.portListPosition.y + portListHeight > windowHeight) {
      this.portListPosition.y = windowHeight - portListHeight - 3;
    }
  }

  async openBoardSelectorDialog() {
    await this.uiService.openBoardSelector();
  }

  appStoreBtn = {
    name: 'MENU.APP_STORE',
    action: 'tool-open',
    data: { type: 'tool', data: "app-store" },
    icon: 'fa-light fa-grid-2-plus',
  }
}

export interface RunState {
  state: 'default' | 'doing' | 'done' | 'error' | 'warn';
  text: string;
}

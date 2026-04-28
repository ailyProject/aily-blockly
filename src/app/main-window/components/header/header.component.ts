import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, isDevMode, OnDestroy, ViewChild, viewChild } from '@angular/core';
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
import { BoardSelectorDialogComponent } from '../board-selector-dialog/board-selector-dialog.component';
import { LoginDialogComponent } from '../login-dialog/login-dialog.component';
import { PlatformService } from '../../../services/platform.service';
import { ProbeRsService } from '../../../services/probe-rs.service';
// import { AppStoreService } from '../../../tools/app-store/app-store.service';
import { AppItem } from '../../../tools/app-store/app-store.config';
import { APP_LIST } from '../../../configs/tool.config';

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
export class HeaderComponent implements OnDestroy {
  headerBtns = HEADER_BTNS;
  headerMenu = HEADER_MENU;
  headerApps = APP_LIST;

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
  private unsaveDialogOpen = false; // 标记未保存对话框是否已打开
  private selectDebounceTimer: ReturnType<typeof setTimeout> | null = null; // 防抖计时器
  private lastSelectedSubItemKey: string | null = null; // 上次选择子菜单项的key（用于判断重复选择）

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

  // 从 AppStoreService 获取要显示在 header 上的 apps
  // get headerApps(): AppItem[] {
  //   return this.appStoreService.getHeaderApps();
  // }

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
    // private appStoreService: AppStoreService
  ) { }

  async ngAfterViewInit() {
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

  showMenu = false;
  openMenu() {
    this.showMenu = !this.showMenu;
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
    let boardname = this.currentBoard.replace(' 2560', ' ').replace(' R3', '');
    this.boardKeywords = [boardname];
    // 如果已有缓存列表，先展示旧数据，再后台刷新
    this.showPortList = true;
    this.getDevicePortList();
  }

  closePortList() {
    this.showPortList = false;
    // this.cd.detectChanges();
  }

  selectPort(item) {
    if (item.action) {
      this.process(item)
      return
    }
    this.currentPort = item.name;
    this.serialService.currentPortInfo = {
      name: item.name,
      text: item.text,
      type: item.type,
      icon: item.icon,
      probeSerial: item.extra?.serial || '',
      probeVidPid: item.extra?.vidPid || '',
    };
    this.closePortList();
  }

  async getDevicePortList(skipDetect = false) {
    const generation = ++this.portListGeneration;
    let portList0: IMenuItem[] = await this.serialService.getSerialPorts();
    if (portList0.length == 0) {
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

    let core = this.projectService.currentBoardConfig['core'].toLowerCase();


    // 添加ESP32相关配置选项
    if (core.indexOf('esp32') > -1) {
      let temp = this.projectService.currentBoardConfig['type'].split(':');
      let board = temp[temp.length - 1];
      let esp32config = await this.projectService.updateEsp32ConfigMenu(board);
      if (esp32config) {
        portList0 = portList0.concat(esp32config)
      }
      // console.log('ESP32配置选项:', esp32config);
    }

    // 添加STM32相关配置选项
    if (core.indexOf('stm32') > -1 &&
      this.projectService.currentBoardConfig['description'].indexOf('Series') > -1) {
      // 异步检测调试探针，完成后更新缓存并重建列表
      this.detectProbes(generation, portList0, skipDetect);

      let temp = this.projectService.currentBoardConfig['type'].split(':');
      let board = temp[temp.length - 1];
      let stm32config = await this.projectService.updateStm32ConfigMenu(board);
      if (stm32config) {
        portList0 = portList0.concat(stm32config)
      }
    }

    // 添加nRF5相关配置选项
    if (core.indexOf('nrf5') > -1) {
      // 异步检测调试探针（nRF52）
      this.detectProbes(generation, portList0, skipDetect);

      let temp = this.projectService.currentBoardConfig['type'].split(':');
      let board = temp[temp.length - 1];
      // console.log('nRF5开发板标识:', board);
      let nrf5config = await this.projectService.updateNrf5ConfigMenu(board);
      if (nrf5config) {
        portList0 = portList0.concat(nrf5config)
      }
    }

    // 添加切换开发板功能
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

  onClick(item, event = null) {
    this.process(item, event);
  }

  isOpenTool(btn) {
    if (btn.data.type == 'terminal') {
      return this.terminalIsOpen;
    } else if (btn.data && btn.data.data) {
      return this.openToolList.indexOf(btn.data.data) !== -1;
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
          this.projectService.saveAs(path);
        }
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
        this.updateService.checkForUpdates();
        break;
      case 'browser-open':
        this.electronService.openUrl(item.data.url);
        break;
      case 'app-exit':
        this.close();
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

  private resolveActionErrorState(err: any, nestedKeys: string[] = []): RunState['state'] {
    const directState = err?.state;
    if (this.isValidRunState(directState)) {
      return directState;
    }

    for (const key of nestedKeys) {
      const nestedState = err?.[key]?.state;
      if (this.isValidRunState(nestedState)) {
        return nestedState;
      }
    }

    return 'error';
  }

  private isValidRunState(state: any): state is RunState['state'] {
    return ['default', 'doing', 'done', 'error', 'warn'].includes(state);
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

  async close() {
    const canClose = await this.checkUnsavedChanges('close');
    if (canClose) {
      window['iWindow'].close();
    }
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
          // console.log('快捷键触发:', menuItem.name, shortcutKey);

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

  openLoginDialog() {
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '350px',
      nzContent: LoginDialogComponent
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

  // 判断路由是否为 ['/main/blockly-editor', '/main/code-editor']中的一个，如果是返回true
  isLoaded() {
    for (const router of ['/main/blockly-editor', '/main/code-editor']) {
      if (this.router.url.indexOf(router) > -1) {
        return true;
      }
    }
  }

  // 选择子菜单项-修改编译上传配置
  async selectSubItem(subItem: IMenuItem) {
    console.log('选择子菜单项:', subItem);

    if (this.lastSelectedSubItemKey === (subItem.key + '_' + subItem.name)) {
      return;
    }

    if (this.selectDebounceTimer !== null) {
      clearTimeout(this.selectDebounceTimer);
    }

    this.selectDebounceTimer = setTimeout(async () => {
      this.selectDebounceTimer = null;
      this.lastSelectedSubItemKey = subItem.key + '_' + subItem.name;

      let packageJson = await this.projectService.getPackageJson();
      packageJson['projectConfig'] = packageJson['projectConfig'] || {};

      // // 判断是否为PartitionScheme并且值为'custom'，如果是则弹出文件选择
      // if (subItem.key === 'PartitionScheme' && subItem.data.toLowerCase() === 'custom') {
      //   const folderPath = await window['ipcRenderer'].invoke('select-file', {
      //     title: '选择分区文件',
      //     path: this.projectService.currentProjectPath,
      //   });

      //   // console.log('选中的分区文件路径：', folderPath);

      //   if (!folderPath) {
      //     this.message.warning('未选择分区文件，已取消');
      //     return;
      //   }

      //   // 执行复制操作，复制到项目根目录下的 'partitions.csv'
      //   const destPath = window['path'].join(this.projectService.currentProjectPath, 'partitions.csv');
      //   if (folderPath != destPath) {
      //     // console.log('复制分区文件到项目目录:', destPath);
      //     try {
      //       window['fs'].copySync(folderPath, destPath);
      //     } catch (error) {
      //       console.warn('复制分区文件失败:', error);
      //       this.message.error('复制分区文件失败');
      //       return;
      //     }
      //   }
      // }

      packageJson['projectConfig'][subItem.key] = subItem.data;
      this.projectService.setPackageJson(packageJson);
      // 判断是否是STM32，是则更新项目配置
      if (this.projectService.currentBoardConfig['core'].indexOf('stm32') > -1 &&
        this.projectService.currentBoardConfig['description'].indexOf('Series') > -1) {
        // 如果subItem包含pnum variant字段，则调用比较函数
        if (subItem.key === 'pnum' && subItem.extra?.build.variant) {
          let newPinConfig = subItem;
          this.projectService.compareStm32PinConfig(newPinConfig)
        }
      }

      // 判断是否是nRF5的softdevice选择，如果是则直接烧录softdevice
      if (this.projectService.currentBoardConfig['core']?.indexOf('nRF5') > -1 &&
        subItem.key === 'softdevice') {
        // 检查串口是否已选择
        if (!this.serialService.currentPort) {
          this.message.warning(this.translate.instant('NRF5.SELECT_PORT_FIRST') || '请先选择串口');
          return;
        }

        // 通过 UploaderService 调用烧录方法（使用 ActionService 分发到 _UploaderService）
        await this.uploaderService.flashSoftdevice(subItem.data, this.serialService.currentPort);
      }

      // 触发预编译操作：配置变更后自动触发预编译
      this.builderService.triggerPreprocess('config-changed');
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
    // 获取开发板列表
    let boardList = await this.configService.loadBoardList();
    console.log(boardList);

    // 显示开发板选择对话框
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '400px',
      nzContent: BoardSelectorDialogComponent,
      nzData: {
        boardList: boardList
      }
    });

    // // 处理对话框返回结果
    // modalRef.afterClose.subscribe(result => {
    //   if (result && result.result === 'confirm') {
    //     // 开发板已经在对话框内切换完成，只需要更新UI
    //     this.cd.detectChanges();
    //   }
    // });
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

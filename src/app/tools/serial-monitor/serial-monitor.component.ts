import { ChangeDetectorRef, ChangeDetectionStrategy, Component, ViewChild, ElementRef, AfterViewInit, OnDestroy, viewChild, viewChildren, signal, effect, untracked, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '@core/app-shell/public-api';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { DataItemComponent } from './components/data-item/data-item.component';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { PortItem, SerialService } from '@domain/device/public-api';
import { ProjectService } from '@domain/project/public-api';
import { MenuComponent } from '../../components/menu/menu.component';
import { SerialMonitorService, dataItem } from './serial-monitor.service';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import { RIGHT_MENU } from './right-menu.config';
import { HistoryMessageListComponent } from './components/history-message-list/history-message-list.component';
import { QuickSendListComponent } from './components/quick-send-list/quick-send-list.component';
import { BAUDRATE_LIST } from './config';
import { SettingMoreComponent } from './components/setting-more/setting-more.component';
import { QuickSendEditorComponent } from './components/quick-send-editor/quick-send-editor.component';
import { NzMessageService } from 'ng-zorro-antd/message';
import { SearchBoxComponent } from './components/search-box/search-box.component';
import { SerialChartComponent } from './components/serial-chart/serial-chart.component';
import { Buffer } from 'buffer';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { ConfigService, ToolI18nService } from '@core/preferences/public-api';
import { ElectronService } from '@core/platform/public-api';

interface UploadRestoreContext {
  port: string;
  connectOptions: any;
}

@Component({
  selector: 'app-serial-monitor',
  imports: [
    // InnerWindowComponent,
    NzSelectModule,
    NzInputModule,
    NzButtonModule,
    FormsModule,
    NzToolTipModule,
    ToolContainerComponent,
    NzResizableModule,
    SubWindowComponent,
    CommonModule,
    DataItemComponent,
    NzSwitchModule,
    MenuComponent,
    HistoryMessageListComponent,
    QuickSendListComponent,
    SettingMoreComponent,
    QuickSendEditorComponent,
    SearchBoxComponent,
    SerialChartComponent,
    TranslateModule
  ],
  templateUrl: './serial-monitor.component.html',
  styleUrl: './serial-monitor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SerialMonitorComponent {
  private destroyRef = inject(DestroyRef);

  // requestAnimationFrame ID，用于合并高频数据更新到单帧渲染
  private rafId: number | null = null;

  // TanStack Virtual 滚动容器引用
  dataListScrollEl = viewChild<ElementRef<HTMLDivElement>>('dataListBox');

  // 虚拟行元素引用（用于动态测量高度）
  virtualRows = viewChildren<ElementRef<HTMLDivElement>>('virtualRow');

  // 数据数量 signal，驱动 virtualizer 响应式更新
  dataCount = signal(0);

  // TanStack 虚拟化器
  virtualizer = injectVirtualizer(() => ({
    scrollElement: this.dataListScrollEl(),
    count: this.dataCount(),
    estimateSize: () => 26,
    overscan: 10,
  }));

  get dataList() {
    return this.serialMonitorService.dataList;
  }

  get viewMode() {
    return this.serialMonitorService.viewMode;
  }

  switchValue = false;

  get windowInfo() {
    if (this.currentPort) {
      return `串口监视器（${this.currentPort} - ${this.currentBaudRate}）`;
    } else {
      return '串口监视器';
    }
  }

  get autoScroll() {
    return this.serialMonitorService.viewMode.autoScroll;
  }

  get autoWrap() {
    return this.serialMonitorService.viewMode.autoWrap;
  }

  get showTimestamp() {
    return this.serialMonitorService.viewMode.showTimestamp;
  }

  get showHex() {
    return this.serialMonitorService.viewMode.showHex;
  }

  get showCtrlChar() {
    return this.serialMonitorService.viewMode.showCtrlChar;
  }

  get hexMode() {
    return this.serialMonitorService.inputMode.hexMode;
  }

  get sendByEnter() {
    return this.serialMonitorService.inputMode.sendByEnter
  }

  get endR() {
    return this.serialMonitorService.inputMode.endR
  }

  get endN() {
    return this.serialMonitorService.inputMode.endN
  }

  inputValue;

  currentPort;
  currentBaudRate = '9600';
  currentUrl;
  private connectedPort: string | null = null;
  private uploadRestoreContext: UploadRestoreContext | null = null;

  private cancelUploadReconnect() {
    this.uploadRestoreContext = null;
  }

  private getConnectOptions(port = this.currentPort) {
    return {
      path: port,
      baudRate: parseInt(this.currentBaudRate),
      dataBits: parseInt(this.dataBits),
      stopBits: parseFloat(this.stopBits),
      parity: this.parity,
      flowControl: this.flowControl
    };
  }

  private getUploadPortFromSignal(action: any) {
    return action?.payload?.port || this.serialService.currentPort || null;
  }

  private pauseForUpload(uploadPort: string | null): Promise<void> | null {
    this.uploadRestoreContext = null;
    if (!uploadPort || !this.switchValue || this.connectedPort !== uploadPort) {
      return null;
    }

    this.uploadRestoreContext = {
      port: uploadPort,
      connectOptions: this.getConnectOptions(uploadPort)
    };
    this.switchValue = false;
    const released = this.serialMonitorService.disconnect().then(result => {
      if (result) {
        this.connectedPort = null;
      } else {
        this.uploadRestoreContext = null;
        this.switchValue = true;
      }
      this.cd.detectChanges();
    }).catch(() => {
      this.uploadRestoreContext = null;
      this.switchValue = true;
      this.cd.detectChanges();
    });
    this.cd.detectChanges();
    return released;
  }

  private restoreAfterUpload(uploadPort: string | null) {
    const context = this.uploadRestoreContext;
    this.uploadRestoreContext = null;
    if (!context || !uploadPort || context.port !== uploadPort || this.switchValue) {
      return;
    }

    this.currentPort = context.port;
    this.switchValue = true;
    this.serialMonitorService.connect(context.connectOptions).then(result => {
      if (result) {
        this.connectedPort = context.port;
      } else {
        this.connectedPort = null;
        this.switchValue = false;
      }
      this.cd.detectChanges();
    }).catch(() => {
      this.connectedPort = null;
      this.switchValue = false;
      this.cd.detectChanges();
    });
    this.cd.detectChanges();
  }

  // 添加高级串口设置相关属性
  dataBits = '8';
  stopBits = '1';
  parity = 'none';
  flowControl = 'none';

  get projectData() {
    return this.projectService.currentPackageData;
  }

  get currentBoard() {
    return this.projectData.board;
  }

  constructor(
    private projectService: ProjectService,
    private serialService: SerialService,
    private serialMonitorService: SerialMonitorService,
    private uiService: UiService,
    private router: Router,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private translate: TranslateService,
    private configService: ConfigService,
    private electronService: ElectronService,
    private toolI18n: ToolI18nService
  ) {
    // 当虚拟行元素变化时，动态测量每个元素的实际高度
    effect(() => {
      const rows = this.virtualRows();
      untracked(() => {
        for (const row of rows) {
          this.virtualizer.measureElement(row.nativeElement);
        }
      });
    });
  }

  async ngOnInit() {
    await this.toolI18n.load('serial-monitor');

    this.currentUrl = this.router.url;

    // 加载保存的串口监视器配置
    this.loadSavedConfig();

    // 仅当用户选中的是串口设备（非 debugger）时，同步到串口监视器
    if (this.serialService.currentPort && this.serialService.currentPortInfo?.type !== 'debugger') {
      this.currentPort = this.serialService.currentPort;
    }

    // 初始化数据数量
    if (this.dataList.length > 0) {
      this.dataCount.set(this.dataList.length);
    }
  }

  ngAfterViewInit() {
    this.serialMonitorService.dataUpdated
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        this.handleDataUpdate(data);
      });

    this.serialMonitorService.connectionStatus
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((isConnected) => {
        if (!isConnected) {
          this.connectedPort = null;
        }
      });

    // 检查并设置默认串口
    this.checkAndSetDefaultPort();

    // 监听工具信号，处理上传过程中的串口断开/重连
    this.uiService.actionSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((action: any) => {
        if (action.action === 'signal' && action.type === 'tool') {
          const signal = action.data as string;
          if (signal === 'serial-monitor:disconnect') {
            const releasePromise = this.pauseForUpload(this.getUploadPortFromSignal(action));
            if (releasePromise && Array.isArray(action?.payload?.waitFor)) {
              action.payload.waitFor.push(releasePromise);
            }
          } else if (signal === 'serial-monitor:connect') {
            this.restoreAfterUpload(this.getUploadPortFromSignal(action));
          }
        }
      });

    // 如果已有数据,滚动到底部
    if (this.dataList.length > 0) {
      this.scrollToBottom();
    }
  }

  @ViewChild('serialChart') serialChartRef!: SerialChartComponent;

  private scrollTimeoutId: any;

  /** 用户是否停留在列表尾部（上滚查看历史时为 false，避免新数据强行拉到底） */
  private userFollowingTail = true;
  /** 距底部 ≤ 此值视为贴底（与 RELEASE 形成滞回，避免阈值附近上下抖动） */
  private static readonly FOLLOW_STICK_PX = 40;
  /** 距底部 ≥ 此值视为已离开尾部（须大于 STICK） */
  private static readonly FOLLOW_RELEASE_PX = 100;
  /** scrollToIndex 触发的 scroll 期间为 true，用于避免误判贴底 */
  private serialScrollProgrammatic = false;

  onDataListScroll(): void {
    const el = this.dataListScrollEl()?.nativeElement;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const distanceFromBottom = maxScroll - el.scrollTop;
    const prevFollowing = this.userFollowingTail;

    // 跟到底过程中中间帧 distanceFromBottom 可能暂时很大，不得误判为用户离开
    if (this.serialScrollProgrammatic && prevFollowing) {
      return;
    }

    if (distanceFromBottom >= SerialMonitorComponent.FOLLOW_RELEASE_PX) {
      this.userFollowingTail = false;
    } else if (distanceFromBottom <= SerialMonitorComponent.FOLLOW_STICK_PX) {
      // 程序滚动且用户已上滚时，不得把 false 误判成贴底
      if (!(this.serialScrollProgrammatic && !prevFollowing)) {
        this.userFollowingTail = true;
      }
    }
    // STICK～RELEASE 之间保持原状态（滞回带）
  }

  private scrollToBottom() {
    if (!this.autoScroll || !this.userFollowingTail) return;
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.scrollTimeoutId = setTimeout(() => {
      const count = this.dataCount();
      if (count > 0) {
        this.serialScrollProgrammatic = true;
        this.virtualizer.scrollToIndex(count - 1, { align: 'end' });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.serialScrollProgrammatic = false;
          });
        });
      }
    }, 30);
  }

  // 处理数据更新：用 requestAnimationFrame 合并多次数据事件到一帧内渲染
  private handleDataUpdate(data: dataItem | void) {
    // 如果已有待处理的RAF，跳过，等下一帧统一刷新
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const count = this.dataList.length;
      this.dataCount.set(count);
      this.cd.detectChanges();
      this.scrollToBottom();
    });
  }


  // 检查串口列表并设置默认串口
  private async checkAndSetDefaultPort() {
    try {
      const ports = await this.serialService.getSerialPorts();
      if (ports && ports.length === 1 && !this.currentPort) {
        // 只有一个串口且当前没有选择串口时，设为默认
        this.currentPort = ports[0].name;
        this.cd.detectChanges();
      }
    } catch (error) {
      console.warn('获取串口列表失败:', error);
    }
  }

  // 加载保存的串口监视器配置
  private loadSavedConfig() {
    const savedConfig = this.configService.data.serialMonitor;
    if (savedConfig) {
      // 只有在当前没有选择串口时才加载保存的串口
      if (!this.currentPort && savedConfig.port) {
        this.currentPort = savedConfig.port;
      }
      if (savedConfig.baudRate) {
        this.currentBaudRate = savedConfig.baudRate;
      }
      if (savedConfig.dataBits != null && savedConfig.dataBits !== '') {
        this.dataBits = String(savedConfig.dataBits);
      }
      if (savedConfig.stopBits != null && savedConfig.stopBits !== '') {
        this.stopBits = String(savedConfig.stopBits);
      }
      if (savedConfig.parity) {
        this.parity = savedConfig.parity;
      }
      if (savedConfig.flowControl) {
        this.flowControl = savedConfig.flowControl;
      }
    }
  }

  // 保存串口监视器配置
  private saveSerialConfig() {
    if (!this.configService.data.serialMonitor) {
      this.configService.data.serialMonitor = {};
    }
    this.configService.data.serialMonitor.port = this.currentPort;
    this.configService.data.serialMonitor.baudRate = this.currentBaudRate;
    this.configService.data.serialMonitor.dataBits = this.dataBits;
    this.configService.data.serialMonitor.stopBits = this.stopBits;
    this.configService.data.serialMonitor.parity = this.parity;
    this.configService.data.serialMonitor.flowControl = this.flowControl;
    this.configService.save();
  }

  ngOnDestroy() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.serialMonitorService.disconnect();
  }

  close() {
    this.uiService.closeTool('serial-monitor');
  }

  bottomHeight = 210;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  openMore() { }

  // 串口选择列表相关 
  showPortList = false;
  portList: PortItem[] = []
  boardKeywords = []; // 这个用来高亮显示正确开发板，如['arduino uno']，则端口菜单中如有包含'arduino uno'的串口则高亮显示
  position = { x: 0, y: 0 }; // 右键菜单位置
  private portListGeneration = 0;

  openPortList(el) {
    // console.log(el.srcElement);
    // 获取元素左下角位置
    let rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;

    if (this.currentBoard) {
      let boardname = this.currentBoard.replace(' 2560', ' ').replace(' R3', '');
      this.boardKeywords = [boardname];
    }
    if (this.portList.length === 0) {
      this.portList = [
        {
          name: 'Loading...',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-spinner',
          disabled: true,
        }
      ];
    }
    this.showPortList = true;
    this.getDevicePortList();
  }

  async getDevicePortList() {
    const generation = ++this.portListGeneration;
    let ports: PortItem[] = [];
    try {
      ports = await this.serialService.getSerialPorts();
    } catch (error) {
      console.warn('获取串口列表失败:', error);
    }

    if (generation !== this.portListGeneration) {
      return;
    }

    if (ports && ports.length > 0) {
      this.portList = ports;
    } else {
      this.portList = [
        {
          name: 'Device not found',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-triangle-exclamation',
          disabled: true,
        }
      ]
    }
    this.cd.detectChanges();
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem) {
    this.cancelUploadReconnect();
    this.currentPort = portItem.name;
    this.closePortList();
    this.saveSerialConfig();
  }

  // 波特率选择列表相关 
  showBaudList = false;
  baudList = BAUDRATE_LIST;

  openBaudList(el) {
    // console.log(el.srcElement);
    // 获取元素左下角位置
    let rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.showBaudList = !this.showBaudList;
  }

  closeBaudList() {
    this.showBaudList = false;
    this.cd.detectChanges();
  }

  async selectBaud(item) {
    this.cancelUploadReconnect();
    this.closeBaudList();

    const nextBaudRate = String(item.name);
    if (nextBaudRate === this.currentBaudRate) {
      return;
    }

    if (this.serialMonitorService.isPortConnected()) {
      const updated = await this.serialMonitorService.updateBaudRate(Number(item.value ?? item.name));
      if (!updated) {
        this.cd.detectChanges();
        return;
      }
    }

    this.currentBaudRate = nextBaudRate;
    this.saveSerialConfig();
    this.cd.detectChanges();
  }

  async switchPort() {
    this.cancelUploadReconnect();
    if (!this.switchValue) {
      const result = await this.serialMonitorService.disconnect();
      if (result) {
        this.connectedPort = null;
        this.message.success(this.translate.instant('SERIAL.PORT_CLOSED'));
      }
      return;
    }

    if (!this.currentPort) {
      this.message.warning(this.translate.instant('SERIAL.SELECT_PORT_FIRST'));
      setTimeout(() => {
        this.switchValue = false;
      }, 300);
      return;
    }

    try {
      const result = await this.serialMonitorService.connect(this.getConnectOptions());

      if (result) {
        this.connectedPort = this.currentPort;
        this.message.success(this.translate.instant('SERIAL.PORT_OPENED'));
      } else {
        // 连接失败，关闭开关
        this.connectedPort = null;
        this.switchValue = false;
        this.cd.detectChanges();
      }
    } catch (error) {
      // 连接失败，关闭开关
      this.connectedPort = null;
      this.switchValue = false;
      this.cd.detectChanges();
    }
  }

  changeViewMode(name) {
    this.serialMonitorService.viewMode[name] = !this.serialMonitorService.viewMode[name];
    if (name === 'autoScroll' && this.serialMonitorService.viewMode.autoScroll) {
      this.userFollowingTail = true;
      this.scrollToBottom();
    }
  }

  clearView() {
    this.serialMonitorService.clearData();
    this.dataCount.set(0);
    this.userFollowingTail = true;
    this.cd.detectChanges();
    // 清空图表数据
    if (this.serialChartRef) {
      this.serialChartRef.clearChartData();
    }
  }

  changeInputMode(name) {
    this.serialMonitorService.inputMode[name] = !this.serialMonitorService.inputMode[name];
  }

  async send(data?: string) {
    const fromTextarea = arguments.length === 0;
    const payload = fromTextarea ? this.inputValue : data;

    const ok = await this.serialMonitorService.sendData(payload);

    const histRaw = typeof payload === 'string' ? payload : String(payload ?? '');
    if (ok && histRaw.trim() !== '') {
      if (!this.serialMonitorService.sendHistoryList.includes(histRaw)) {
        this.serialMonitorService.sendHistoryList.unshift(histRaw);
        if (this.serialMonitorService.sendHistoryList.length > 20) {
          this.serialMonitorService.sendHistoryList.pop();
        }
      }
    }

    if (ok && fromTextarea) {
      this.inputValue = '';
      this.cd.detectChanges();
    }
  }

  onKeyDown(event: KeyboardEvent) {
    if (this.serialMonitorService.inputMode.sendByEnter) {
      if (event.key === 'Enter') {
        this.send();
        event.preventDefault();
      }
      return;
    }
    if (event.ctrlKey && event.key === 'Enter') {
      this.send();
      event.preventDefault();
    }
  }

  // 清除显示
  cleanInput() {

  }

  exportData() {
    this.serialMonitorService.exportData();
  }

  // 历史记录相关
  showHistoryList = false;
  openHistoryList() {
    this.showHistoryList = !this.showHistoryList;
  }

  get sendHistoryList() {
    return this.serialMonitorService.sendHistoryList;
  }

  editHistory(content: string) {
    this.inputValue = content;
    this.showHistoryList = false;
  }

  resendHistory(content: string) {
    this.inputValue = content;
    this.send();
    this.showHistoryList = false;
  }

  showMoreSettings = false;
  openMoreSettings() {
    this.showMoreSettings = !this.showMoreSettings;
  }

  onSettingsChanged(settings) {
    this.cancelUploadReconnect();
    // 更新组件中的高级设置（统一存为字符串，便于配置持久化与模板绑定）
    this.dataBits = String(settings.dataBits.value);
    this.stopBits = String(settings.stopBits.value);
    this.parity = settings.parity.value;
    this.flowControl = settings.flowControl.value;

    // 保存配置
    this.saveSerialConfig();

    // 如果已经连接，需要断开重连以应用新设置
    if (this.switchValue) {
      this.switchValue = false;
      this.serialMonitorService.disconnect().then(() => {
        setTimeout(() => {
          this.switchValue = true;
          this.switchPort();
        }, 300);
      });
    }
  }

  showQuickSendEditor = false;
  openQuickSendEditor() {
    this.showQuickSendEditor = !this.showQuickSendEditor;
  }

  // 搜索相关
  searchKeyword = '';
  searchResults = [];
  currentSearchIndex = -1;
  searchBoxVisible = false;

  openSearchBox() {
    this.searchBoxVisible = !this.searchBoxVisible;
  }

  keywordChange(keyword: string) {
    this.searchKeyword = keyword;
    this.searchResults = [];
    this.currentSearchIndex = -1;

    if (!keyword || keyword.trim() === '') {
      // 清除所有高亮
      this.cd.detectChanges();
      return;
    }

    // 搜索匹配项
    this.dataList.forEach((item, index) => {
      // 将Buffer数据转为字符串进行搜索
      const itemText = Buffer.isBuffer(item.data) ? item.data.toString() : String(item.data);

      if (itemText.toLowerCase().includes(keyword.toLowerCase())) {
        this.searchResults.push(index);
      }
    });

    // 如果有结果，选择第一个
    if (this.searchResults.length > 0) {
      this.navigateToResult(0);
    }
  }

  navigateToResult(index: number) {
    if (this.searchResults.length === 0) return;

    // 确保索引在有效范围内
    if (index < 0) index = this.searchResults.length - 1;
    if (index >= this.searchResults.length) index = 0;

    this.currentSearchIndex = index;
    const dataIndex = this.searchResults[index];

    // 更新高亮状态
    this.dataList.forEach((item, idx) => {
      item['searchHighlight'] = idx === dataIndex;
    });

    this.cd.detectChanges();
  }

  navigatePrev() {
    this.navigateToResult(this.currentSearchIndex - 1);
  }

  navigateNext() {
    this.navigateToResult(this.currentSearchIndex + 1);
  }

  onDataItemClick(item: dataItem) {
    console.log(item);
  }

  // 右键菜单相关
  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuItems = JSON.parse(JSON.stringify(RIGHT_MENU));
  private contextMenuItem: dataItem | null = null;

  onDataItemContextMenu(event: MouseEvent, item: dataItem) {
    if (!this.serialMonitorService.viewMode.showTimestamp) return;
    event.preventDefault();
    event.stopPropagation();

    // 先关闭已有菜单
    this.showContextMenu = false;

    this.contextMenuPosition = { x: event.clientX, y: event.clientY };
    this.contextMenuItem = item;
    this.serialMonitorService.viewMode.autoScroll = false;

    // 根据当前 item 状态更新菜单标签
    this.contextMenuItems = JSON.parse(JSON.stringify(RIGHT_MENU));
    if (item.showHex) {
      this.contextMenuItems[1].name = '文本显示';
    }
    if (item.highlight) {
      this.contextMenuItems[2].name = '取消高亮';
    }

    // 延迟一帧确保旧菜单已销毁
    setTimeout(() => {
      this.showContextMenu = true;
      this.cd.detectChanges();
    });
  }

  closeContextMenu() {
    this.showContextMenu = false;
    this.contextMenuItem = null;
    this.cd.detectChanges();
  }

  async contextMenuClick(menuItem: any) {
    const contextMenuItem = this.contextMenuItem;
    if (!contextMenuItem) return;
    switch (menuItem.data.action) {
      case 'copy':
        try {
          await this.electronService.clipboardWriteText(this.getDataItemCopyText(contextMenuItem));
          this.message.info('已复制到剪贴板');
        } catch (error) {
          console.error('Copy serial data failed:', error);
          this.message.error('复制失败');
        }
        break;
      case 'hex':
        contextMenuItem.showHex = !contextMenuItem.showHex;
        break;
      case 'highlight':
        contextMenuItem.highlight = !contextMenuItem.highlight;
        break;
    }
    this.showContextMenu = false;
    this.contextMenuItem = null;
    this.cd.detectChanges();
  }

  private getDataItemCopyText(item: dataItem): string {
    if (Buffer.isBuffer(item.data)) {
      return item.data.toString();
    }

    return item.data == null ? '' : String(item.data);
  }

  showChartBox = false;

  openChartBox() {
    this.showChartBox = !this.showChartBox;
    if (this.showChartBox) {
      // 延迟初始化图表，确保 DOM 元素已渲染
      setTimeout(() => {
        if (this.serialChartRef) {
          this.serialChartRef.initChart();
        }
      }, 100);
    } else {
      if (this.serialChartRef) {
        this.serialChartRef.destroyChart();
      }
    }
  }

  openUrl(url) {
    this.electronService.openUrl(url);
  }
}

import { ChangeDetectorRef, ChangeDetectionStrategy, Component, ViewChild, ElementRef, AfterViewInit, OnDestroy, viewChild, viewChildren, signal, effect, untracked, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { DataItemComponent } from './components/data-item/data-item.component';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { PortItem, SerialService } from '../../services/serial.service';
import { ProjectService } from '../../services/project.service';
import { MenuComponent } from '../../components/menu/menu.component';
import { SerialMonitorService } from './serial-monitor.service';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import { dataItem } from './serial-monitor.service';
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
import { ConfigService } from '../../services/config.service';
import { ElectronService } from '../../services/electron.service';

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
    private electronService: ElectronService
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
    this.currentUrl = this.router.url;

    // 加载保存的串口监视器配置
    this.loadSavedConfig();

    if (this.serialService.currentPort) {
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

    // 检查并设置默认串口
    this.checkAndSetDefaultPort();

    // 监听工具信号，处理上传过程中的串口断开/重连
    this.uiService.actionSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((action: any) => {
      if (action.action === 'signal' && action.type === 'tool') {
        const signal = action.data as string;
        if (signal === 'serial-monitor:disconnect' && this.switchValue) {
          this.switchValue = false;
          this.serialMonitorService.disconnect();
          this.cd.detectChanges();
        } else if (signal === 'serial-monitor:connect' && !this.switchValue && this.currentPort) {
          this.switchValue = true;
          this.serialMonitorService.connect({
            path: this.currentPort,
            baudRate: parseInt(this.currentBaudRate),
            dataBits: parseInt(this.dataBits),
            stopBits: parseFloat(this.stopBits),
            parity: this.parity,
            flowControl: this.flowControl
          }).then(result => {
            if (!result) {
              this.switchValue = false;
            }
            this.cd.detectChanges();
          });
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

  private scrollToBottom() {
    if (!this.autoScroll) return;
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.scrollTimeoutId = setTimeout(() => {
      const count = this.dataCount();
      if (count > 0) {
        this.virtualizer.scrollToIndex(count - 1, { align: 'end' });
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
      if (savedConfig.dataBits) {
        this.dataBits = savedConfig.dataBits;
      }
      if (savedConfig.stopBits) {
        this.stopBits = savedConfig.stopBits;
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
    this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList() {
    let ports = await this.serialService.getSerialPorts();
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
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem) {
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

  selectBaud(item) {
    this.currentBaudRate = item.name;
    this.closeBaudList();
    this.saveSerialConfig();
  }

  async switchPort() {
    if (!this.switchValue) {
      const result = await this.serialMonitorService.disconnect();
      if (result) {
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
      const result = await this.serialMonitorService.connect({
        path: this.currentPort,
        baudRate: parseInt(this.currentBaudRate),
        dataBits: parseInt(this.dataBits),
        stopBits: parseFloat(this.stopBits),
        parity: this.parity,
        flowControl: this.flowControl
      });

      if (result) {
        this.message.success(this.translate.instant('SERIAL.PORT_OPENED'));
        // 发送DTR信号
        setTimeout(() => {
          this.serialMonitorService.sendSignal('DTR');
        }, 50);
      } else {
        // 连接失败，关闭开关
        this.switchValue = false;
        this.cd.detectChanges();
      }
    } catch (error) {
      // 连接失败，关闭开关
      this.switchValue = false;
      this.cd.detectChanges();
    }
  }

  changeViewMode(name) {
    this.serialMonitorService.viewMode[name] = !this.serialMonitorService.viewMode[name];
  }

  clearView() {
    this.serialMonitorService.clearData();
    this.dataCount.set(0);
    this.cd.detectChanges();
    // 清空图表数据
    if (this.serialChartRef) {
      this.serialChartRef.clearChartData();
    }
  }

  changeInputMode(name) {
    this.serialMonitorService.inputMode[name] = !this.serialMonitorService.inputMode[name];
  }

  send(data = this.inputValue) {
    this.serialMonitorService.sendData(data);
    // this.serialMonitorService.dataUpdated.next({});
    if (this.inputValue.trim() !== '') {
      // 避免保存空内容到历史记录
      if (!this.serialMonitorService.sendHistoryList.includes(this.inputValue)) {
        this.serialMonitorService.sendHistoryList.unshift(this.inputValue); // 添加到列表开头
        // 限制历史记录数量，例如最多保存20条
        if (this.serialMonitorService.sendHistoryList.length > 20) {
          this.serialMonitorService.sendHistoryList.pop();
        }
      }
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
    // 更新组件中的高级设置
    this.dataBits = settings.dataBits.value;
    this.stopBits = settings.stopBits.value;
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

  contextMenuClick(menuItem: any) {
    if (!this.contextMenuItem) return;
    switch (menuItem.data.action) {
      case 'copy':
        navigator.clipboard.writeText(this.contextMenuItem.data).then(() => {
          this.message.info('已复制到剪贴板');
        });
        break;
      case 'hex':
        this.contextMenuItem.showHex = !this.contextMenuItem.showHex;
        break;
      case 'highlight':
        this.contextMenuItem.highlight = !this.contextMenuItem.highlight;
        break;
    }
    this.showContextMenu = false;
    this.contextMenuItem = null;
    this.cd.detectChanges();
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

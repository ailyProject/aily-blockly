import { ChangeDetectorRef, Component, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
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
import { UiScrollModule, Datasource, SizeStrategy } from 'ngx-ui-scroll';
import { dataItem } from './serial-monitor.service';
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
    UiScrollModule,
    TranslateModule
  ],
  templateUrl: './serial-monitor.component.html',
  styleUrl: './serial-monitor.component.scss',
})
export class SerialMonitorComponent {
  // ngx-ui-scroll 数据源
  datasource;

  // 记录上次的数据长度，用于优化更新
  private lastDataLength = 0;

  // 更新防抖定时器
  private updateTimer: any = null;

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
  ) { }

  async ngOnInit() {
    this.currentUrl = this.router.url;

    // 加载保存的串口监视器配置
    this.loadSavedConfig();

    if (this.serialService.currentPort) {
      this.currentPort = this.serialService.currentPort;
    }

    // 初始化 ngx-ui-scroll 数据源
    let startIndex = 0;
    if (this.dataList.length > 0) {
      startIndex = this.dataList.length - 1;
    }

    this.datasource = new Datasource({
      get: (index: number, count: number) => {
        const data = this.dataList;
        const startIdx = Math.max(0, index);
        const endIdx = Math.min(data.length, startIdx + count);
        const items = data.slice(startIdx, endIdx);
        return Promise.resolve(items);
      },
      settings: {
        minIndex: 0,
        startIndex,
        sizeStrategy: SizeStrategy.Average, // 动态学习平均高度
        itemSize: 26, // 设置一个合理的初始预估值
        bufferSize: 30, // 适中缓冲区
        padding: 0.5
      }
    });
  }

  ngAfterViewInit() {
    this.serialMonitorService.dataUpdated.subscribe((data) => {
      this.handleDataUpdate(data);
    });

    // 检查并设置默认串口
    this.checkAndSetDefaultPort();

    // 上传过程中断开串口连接
    this.uiService.stateSubject.subscribe((state) => {
      if (state.state == 'doing' && state.text == '固件上传中...' && this.switchValue) {
        this.switchValue = false;
        this.serialMonitorService.disconnect();
      }
    });

    // 如果已有数据,滚动到底部
    if (this.dataList.length > 0) {
      this.lastDataLength = this.dataList.length; // 初始化时记录数据长度
      this.scrollToBottom();
    }
  }

  @ViewChild('dataListBox', { static: false }) dataListBoxRef!: ElementRef<HTMLDivElement>;
  @ViewChild('serialChart') serialChartRef!: SerialChartComponent;

  private scrollToBottom() {
    if (!this.autoScroll) return;
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (this.dataListBoxRef) {
          const element = this.dataListBoxRef.nativeElement;
          element.scrollTop = element.scrollHeight;
        }
      });
    }, 50);
  }

  // 处理数据更新
  private handleDataUpdate(data: dataItem | void) {
    if (!data) {
      this.cd.detectChanges();
      this.scrollToBottom();
      return;
    }
    // 如果数据被清空
    if (this.dataList.length === 0) {
      this.lastDataLength = 0;
      if (this.datasource && this.datasource.adapter) {
        this.datasource.adapter.reload(0);
        this.cd.detectChanges();
      }
      return;
    }

    // this.datasource.adapter.append({
    //   items: [data],
    // });

    // this.cd.detectChanges();
    let currentDataCount = this.dataList.length;
    // 计算新增的数据条数
    const newItemsCount = currentDataCount - this.lastDataLength;

    if (newItemsCount > 0 && this.datasource && this.datasource.adapter) {
      // 使用 append 方法增量添加新数据,避免闪烁
      const newItems = [];
      for (let i = this.lastDataLength; i < currentDataCount; i++) {
        const item = this.dataList[i];
        item['id'] = i;
        newItems.push(item);
      }

      // 追加新数据到末尾
      this.datasource.adapter.append({
        items: newItems
      });

      // 更新最后的数据长度
      this.lastDataLength = currentDataCount;
    }
    this.cd.detectChanges();
    // 如果开启自动滚动,滚动到底部
    this.scrollToBottom();
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
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
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
    this.serialMonitorService.dataList = [];
    this.lastDataLength = 0;
    if (this.datasource && this.datasource.adapter) {
      // 清空时使用 reload 是合理的,因为需要完全重置
      this.datasource.adapter.reload(0);
    }
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

    // ngx-ui-scroll 会自动处理滚动到对应位置
    this.cd.detectChanges();
  }

  navigatePrev() {
    this.navigateToResult(this.currentSearchIndex - 1);
  }

  navigateNext() {
    this.navigateToResult(this.currentSearchIndex + 1);
  }

  // trackBy 函数用于优化 ngx-ui-scroll 性能
  trackById(index: number, item: dataItem): any {
    return item['id'] !== undefined ? item['id'] : index;
  }

  onDataItemClick(item: dataItem) {
    console.log(item);
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

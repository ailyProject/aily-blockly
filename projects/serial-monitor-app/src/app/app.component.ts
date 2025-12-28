import { ChangeDetectorRef, Component, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { UiScrollModule, Datasource, SizeStrategy } from 'ngx-ui-scroll';
import { Buffer } from 'buffer';

import { DataItemComponent } from './components/data-item/data-item.component';
import { MenuComponent } from './components/menu/menu.component';
import { QuickSendListComponent } from './components/quick-send-list/quick-send-list.component';
import { SettingMoreComponent } from './components/setting-more/setting-more.component';
import { SearchBoxComponent } from './components/search-box/search-box.component';
import { SerialMonitorService } from './services/serial-monitor.service';
import { PenpalService } from './penpal/penpal.service';
import { BAUDRATE_LIST } from './config/serial.config';
import { DataItem, PortInfo } from './penpal/types';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    NzSelectModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzResizableModule,
    NzSwitchModule,
    DataItemComponent,
    MenuComponent,
    QuickSendListComponent,
    SettingMoreComponent,
    SearchBoxComponent,
    UiScrollModule
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  datasource: any;

  private lastDataLength = 0;
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
    return this.serialMonitorService.inputMode.sendByEnter;
  }

  get endR() {
    return this.serialMonitorService.inputMode.endR;
  }

  get endN() {
    return this.serialMonitorService.inputMode.endN;
  }

  inputValue = '';

  currentPort = '';
  currentBaudRate = '9600';

  // 高级串口设置
  dataBits = '8';
  stopBits = '1';
  parity = 'none';
  flowControl = 'none';

  constructor(
    private serialMonitorService: SerialMonitorService,
    private penpalService: PenpalService,
    private cd: ChangeDetectorRef
  ) { }

  async ngOnInit() {
    // 订阅来自父窗口的端口设置
    this.penpalService.portChanged.subscribe((port) => {
      this.currentPort = port;
      this.cd.detectChanges();
    });

    this.penpalService.baudRateChanged.subscribe((baudRate) => {
      this.currentBaudRate = baudRate;
      this.cd.detectChanges();
    });

    // 订阅连接状态
    this.serialMonitorService.connectionStatus.subscribe((connected) => {
      this.switchValue = connected;
      this.cd.detectChanges();
    });

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
        sizeStrategy: SizeStrategy.Average,
        itemSize: 26,
        bufferSize: 30,
        padding: 0.5
      }
    });
  }

  ngAfterViewInit() {
    this.serialMonitorService.dataUpdated.subscribe((data) => {
      this.handleDataUpdate(data);
    });

    // 如果已有数据,滚动到底部
    if (this.dataList.length > 0) {
      this.lastDataLength = this.dataList.length;
      this.scrollToBottom();
    }
  }

  @ViewChild('dataListBox', { static: false }) dataListBoxRef!: ElementRef<HTMLDivElement>;

  private scrollToBottom(fast = false) {
    if (!this.autoScroll) return;
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (this.dataListBoxRef) {
          const element = this.dataListBoxRef.nativeElement;
          if (fast) {
            element.scrollTop = element.scrollHeight;
          } else {
            element.scrollTo({
              top: element.scrollHeight,
              behavior: 'smooth'
            });
          }
        }
      });
    }, fast ? 50 : 100);
  }

  private handleDataUpdate(data: DataItem | void) {
    if (!data) {
      this.cd.detectChanges();
      this.scrollToBottom();
      return;
    }

    if (this.dataList.length === 0) {
      this.lastDataLength = 0;
      if (this.datasource && this.datasource.adapter) {
        this.datasource.adapter.reload(0);
        this.cd.detectChanges();
      }
      return;
    }

    let currentDataCount = this.dataList.length;
    const newItemsCount = currentDataCount - this.lastDataLength;

    if (newItemsCount > 0 && this.datasource && this.datasource.adapter) {
      const newItems = [];
      for (let i = this.lastDataLength; i < currentDataCount; i++) {
        const item = this.dataList[i] as any;
        item['id'] = i;
        newItems.push(item);
      }

      this.datasource.adapter.append({
        items: newItems
      });

      this.lastDataLength = currentDataCount;
    }
    this.cd.detectChanges();
    this.scrollToBottom(true);
  }

  ngOnDestroy() {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.serialMonitorService.disconnect();
  }

  close() {
    this.penpalService.closePanel();
  }

  bottomHeight = 210;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 串口选择列表相关
  showPortList = false;
  portList: PortInfo[] = [];
  boardKeywords: string[] = [];
  position = { x: 0, y: 0 };

  async openPortList(el: any) {
    let rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;

    // 获取当前开发板信息用于高亮
    const board = await this.penpalService.getCurrentBoard();
    if (board) {
      let boardname = board.replace(' 2560', ' ').replace(' R3', '');
      this.boardKeywords = [boardname];
    }

    await this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList() {
    let ports = await this.serialMonitorService.getPortsList();
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
      ];
    }
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem: any) {
    this.currentPort = portItem.name;
    this.closePortList();
  }

  // 波特率选择列表相关
  showBaudList = false;
  baudList = BAUDRATE_LIST;

  openBaudList(el: any) {
    let rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.showBaudList = !this.showBaudList;
  }

  closeBaudList() {
    this.showBaudList = false;
    this.cd.detectChanges();
  }

  selectBaud(item: any) {
    this.currentBaudRate = item.name;
    this.closeBaudList();
  }

  async switchPort() {
    if (!this.switchValue) {
      this.serialMonitorService.disconnect();
      return;
    }

    if (!this.currentPort) {
      await this.penpalService.showMessage('warning', '请先选择串口');
      setTimeout(() => {
        this.switchValue = false;
      }, 300);
      return;
    }

    await this.serialMonitorService.connect({
      path: this.currentPort,
      baudRate: parseInt(this.currentBaudRate),
      dataBits: parseInt(this.dataBits),
      stopBits: parseFloat(this.stopBits),
      parity: this.parity,
      flowControl: this.flowControl
    });

    // 发送DTR信号
    setTimeout(() => {
      this.serialMonitorService.sendSignal('DTR');
    }, 50);
  }

  changeViewMode(name: string) {
    (this.serialMonitorService.viewMode as any)[name] = !(this.serialMonitorService.viewMode as any)[name];
  }

  clearView() {
    this.serialMonitorService.clearData();
    this.lastDataLength = 0;
    if (this.datasource && this.datasource.adapter) {
      this.datasource.adapter.reload(0);
    }
  }

  changeInputMode(name: string) {
    (this.serialMonitorService.inputMode as any)[name] = !(this.serialMonitorService.inputMode as any)[name];
  }

  send(data = this.inputValue) {
    this.serialMonitorService.sendData(data);
    if (this.inputValue.trim() !== '') {
      if (!this.serialMonitorService.sendHistoryList.includes(this.inputValue)) {
        this.serialMonitorService.sendHistoryList.unshift(this.inputValue);
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

  onSettingsChanged(settings: any) {
    this.dataBits = settings.dataBits.value;
    this.stopBits = settings.stopBits.value;
    this.parity = settings.parity.value;
    this.flowControl = settings.flowControl.value;

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
  searchResults: number[] = [];
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
      this.cd.detectChanges();
      return;
    }

    this.dataList.forEach((item, index) => {
      let itemText = '';
      if (Buffer.isBuffer(item.data)) {
        itemText = item.data.toString();
      } else {
        itemText = String(item.data);
      }

      if (itemText.toLowerCase().includes(keyword.toLowerCase())) {
        this.searchResults.push(index);
      }
    });

    if (this.searchResults.length > 0) {
      this.navigateToResult(0);
    }
  }

  navigateToResult(index: number) {
    if (this.searchResults.length === 0) return;

    if (index < 0) index = this.searchResults.length - 1;
    if (index >= this.searchResults.length) index = 0;

    this.currentSearchIndex = index;
    const dataIndex = this.searchResults[index];

    this.dataList.forEach((item, idx) => {
      (item as any)['searchHighlight'] = idx === dataIndex;
    });

    this.cd.detectChanges();
  }

  navigatePrev() {
    this.navigateToResult(this.currentSearchIndex - 1);
  }

  navigateNext() {
    this.navigateToResult(this.currentSearchIndex + 1);
  }

  trackById(index: number, item: DataItem): any {
    return (item as any)['id'] !== undefined ? (item as any)['id'] : index;
  }

  onDataItemClick(item: DataItem) {
    console.log(item);
  }
}

import { ChangeDetectorRef, Component, ViewChild } from '@angular/core';
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
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { dataItem } from './serial-monitor.service';
import { HistoryMessageListComponent } from './components/history-message-list/history-message-list.component';
import { QuickSendListComponent } from './components/quick-send-list/quick-send-list.component';
import { BAUDRATE_LIST } from './config';
import { SettingMoreComponent } from './components/setting-more/setting-more.component';
import { QuickSendEditorComponent } from './components/quick-send-editor/quick-send-editor.component';
import { NzMessageService } from 'ng-zorro-antd/message';
import { SearchBoxComponent } from './components/search-box/search-box.component';
import { Buffer } from 'buffer';

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
    ScrollingModule
  ],
  templateUrl: './serial-monitor.component.html',
  styleUrl: './serial-monitor.component.scss',
})
export class SerialMonitorComponent {

  @ViewChild(CdkVirtualScrollViewport) viewport: CdkVirtualScrollViewport;

  // 标记是否为程序触发的滚动,避免自动滚动被误关闭
  private isProgrammaticScroll = false;

  // 本地数据列表 - 用于 CDK 虚拟滚动
  dataList: dataItem[] = [];

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
  ) { }

  async ngOnInit() {
    this.currentUrl = this.router.url;
    if (this.serialService.currentPort) {
      this.currentPort = this.serialService.currentPort;
    }
    
    // 初始化数据列表
    this.dataList = [...this.serialMonitorService.dataList];
  }

  ngAfterViewInit() {
    // 添加调试日志
    console.log('ngAfterViewInit - viewport:', this.viewport);
    console.log('ngAfterViewInit - dataList length:', this.dataList.length);

    this.serialMonitorService.dataUpdated.subscribe(() => {
      this.handleDataUpdate();
    });

    // 添加滚动事件监听,用于检测用户手动滚动
    setTimeout(() => {
      if (this.viewport) {
        console.log('viewport 已初始化，绑定滚动事件');
        this.viewport.elementScrolled().subscribe(() => {
          this.handleScroll();
        });
      } else {
        console.warn('viewport 未找到');
      }
    }, 100);

    // 检查并设置默认串口
    this.checkAndSetDefaultPort();

    // 上传过程中断开串口连接
    this.uiService.stateSubject.subscribe((state) => {
      if (state.state == 'doing' && state.text == '固件上传中...' && this.switchValue) {
        this.switchValue = false;
        this.serialMonitorService.disconnect();
      }
    });

    if (this.dataList.length > 0) {
      this.scrollToBottom();
    }
  }

  // 处理数据更新
  private handleDataUpdate() {
    // 关键：创建新数组引用，触发 Angular 变更检测和 CDK 虚拟滚动更新
    this.dataList = [...this.serialMonitorService.dataList];
    
    // 如果数据被清空
    if ( this.dataList.length === 0) {
      this.cd.detectChanges();
      return;
    }

    // 强制触发变更检测
    this.cd.detectChanges();

    // 如果viewport还未初始化,直接返回
    if (!this.viewport) {
      console.log('viewport 未初始化');
      return;
    }

    // 如果自动滚动开启,滚动到底部
    if (this.autoScroll) {
      // 在整个更新过程中标记为程序触发的滚动
      this.isProgrammaticScroll = true;

      // 延迟滚动,确保 DOM 更新完成
      setTimeout(() => {
        this.scrollToBottom();
      }, 20);
      
      // 重置滚动标记
      // setTimeout(() => {
      //   this.isProgrammaticScroll = false;
      // }, 300);
    }
  }

  scrollToBottom() {
    try {
      this.viewport.scrollTo({
        bottom: 0,
        behavior: 'smooth'
      });
    } catch (error) {
      console.error('滚动失败:', error);
    }
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

  // 处理滚动事件
  handleScroll() {
    // 如果是程序触发的滚动,忽略此事件
    if (this.isProgrammaticScroll || !this.viewport) {
      return;
    }

    const scrollOffset = this.viewport.measureScrollOffset('bottom');

    // 检查是否手动向上滚动(当距离底部超过10px时)
    if (scrollOffset > 10) {
      // 用户向上滚动了,关闭自动滚动
      if (this.viewMode.autoScroll) {
        this.viewMode.autoScroll = false;
        this.cd.detectChanges();
      }
    }
  }

  ngOnDestroy() {
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
  }

  async switchPort() {
    if (!this.switchValue) {
      this.serialMonitorService.disconnect();
      return;
    }

    if (!this.currentPort) {
      this.message.warning('请先选择串口');
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

  changeViewMode(name) {
    this.serialMonitorService.viewMode[name] = !this.serialMonitorService.viewMode[name];

    // 如果用户重新开启自动滚动，立即滚动到底部
    if (name === 'autoScroll' && this.serialMonitorService.viewMode[name]) {
      this.isProgrammaticScroll = true;
      setTimeout(() => {
        this.scrollToBottom();
      }, 0);
      setTimeout(() => {
        this.isProgrammaticScroll = false;
      }, 300);
    }
  }

  clearView() {
    this.serialMonitorService.dataList = [];
    this.dataList = [];
    this.serialMonitorService.dataUpdated.next({});
  }

  changeInputMode(name) {
    this.serialMonitorService.inputMode[name] = !this.serialMonitorService.inputMode[name];
  }

  send(data = this.inputValue) {
    this.serialMonitorService.sendData(data);
    this.serialMonitorService.dataUpdated.next({});
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
      this.serialMonitorService.dataUpdated.next({});
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

    // 使用虚拟滚动的viewport滚动到指定位置
    if (this.viewport) {
      this.isProgrammaticScroll = true;
      this.viewport.scrollToIndex(dataIndex, 'smooth');
      setTimeout(() => {
        this.isProgrammaticScroll = false;
      }, 300);
    }
  }

  navigatePrev() {
    this.navigateToResult(this.currentSearchIndex - 1);
  }

  navigateNext() {
    this.navigateToResult(this.currentSearchIndex + 1);
  }

  // trackBy 函数优化虚拟滚动性能
  trackByIndex(index: number, item: dataItem): string {
    return item.time;
  }
}

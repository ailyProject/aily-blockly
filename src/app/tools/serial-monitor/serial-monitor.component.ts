import { Component } from '@angular/core';
import { InnerWindowComponent } from '../../components/inner-window/inner-window.component';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ElectronService } from '../../services/electron.service';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { DataItemComponent } from './components/data-item/data-item.component';
import { NzSwitchModule } from 'ng-zorro-antd/switch';

@Component({
  selector: 'app-serial-monitor',
  imports: [
    InnerWindowComponent,
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
  ],
  templateUrl: './serial-monitor.component.html',
  styleUrl: './serial-monitor.component.scss',
})
export class SerialMonitorComponent {

  switchValue = false;

  get windowInfo() {
    return (
      '串口监视器 ' +
      '( ' +
      this.currentPort +
      ' - ' +
      this.currentBaudRate +
      ' )'
    );
  }

  dataList = [
    {
      time: '12:12:12',
      data: 'testtest testtest testtest testtesst testtest testtest testtesst testtest testtest testtesst testtest testtest testtesst testtest testtest testtest',
      dir: '>',
    },
    {
      time: '12:12:13',
      data: 'testtest testtest testtest testtest',
      dir: '<',
    },
    {
      time: '12:12:14',
      data: "error: WiFi connection failed, password incorrect",
      dir: '<',
    },
    {
      time: '12:12:15',
      data: 'testtest testtest testtest testtest',
      dir: '<',
    },
    {
      time: '12:12:16',
      data: 'testtest testtest testtest testtest',
      dir: '<',
    },
    {
      time: '12:12:17',
      data: 'testtest testtest testtest testtest',
      dir: '<',
    },
  ];

  // 波特率
  baudRate = '115200';
  // 自动滚动
  autoScroll = true;
  // 自动换行
  autoWrap = true;
  // 显示时间戳
  showTimestamp = true;
  // HEX显示
  showHex = false;
  // 异常捕获
  showError = false;

  serialList = [];

  inputValue;

  currentPort = 'COM3';
  currentBaudRate = '115200';
  currentUrl;

  constructor(
    private electronService: ElectronService,
    private uiService: UiService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void { }

  close() {
    this.uiService.closeTool('serial-monitor');
  }

  bottomHeight = 180;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  openMore() { }

  async openPortList() {
    if (this.electronService.isElectron) {
      this.serialList = (await window['SerialPort'].list()).map(
        (item) => item.path,
      );
      console.log(this.serialList);
    }
  }

  send(e = '') { }

  //

  // 清除显示
  clean() { }
}

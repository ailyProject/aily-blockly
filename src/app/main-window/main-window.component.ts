import { Component, ChangeDetectorRef, ViewChild } from '@angular/core';
import { FooterComponent } from './components/footer/footer.component';
import { HeaderComponent } from './components/header/header.component';
import { CommonModule } from '@angular/common';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { AilyChatComponent } from '../tools/aily-chat/aily-chat.component';
import { TerminalComponent } from '../tools/terminal/terminal.component';
import { LogComponent } from '../tools/log/log.component';
import { UiService } from '../services/ui.service';
import { SubappContainerComponent, SUBAPP_CONFIGS, SubappBridgeService } from '../components/subapp-container';
import { SerialService } from '../services/serial.service';
import { ElectronService } from '../services/electron.service';
import { CodeViewerComponent } from '../editors/blockly-editor/tools/code-viewer/code-viewer.component';
import { ProjectService } from '../services/project.service';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AppStoreComponent } from '../tools/app-store/app-store.component';
import { UpdateService } from '../services/update.service';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NpmService } from '../services/npm.service';
import { SimulatorComponent } from '../tools/simulator/simulator.component';
import { Router, RouterModule } from '@angular/router';
import { ConfigService } from '../services/config.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { FloatSiderComponent } from '../components/float-sider/float-sider.component';
import { CloudSpaceComponent } from '../tools/cloud-space/cloud-space.component';
import { UserCenterComponent } from '../tools/user-center/user-center.component';
import { ModelStoreComponent } from '../tools/model-store/model-store.component';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-main-window',
  imports: [
    CommonModule,
    HeaderComponent,
    FooterComponent,
    NzLayoutModule,
    NzResizableModule,
    NzTabsModule,
    AilyChatComponent,
    TerminalComponent,
    LogComponent,
    SubappContainerComponent,
    CodeViewerComponent,
    SimplebarAngularModule,
    AppStoreComponent,
    NzModalModule,
    SimulatorComponent,
    RouterModule,
    NzToolTipModule,
    NzModalModule,
    FloatSiderComponent,
    CloudSpaceComponent,
    UserCenterComponent,
    ModelStoreComponent
  ],
  templateUrl: './main-window.component.html',
  styleUrl: './main-window.component.scss',
})
export class MainWindowComponent {
  @ViewChild('logComponent') logComponent!: LogComponent;
  @ViewChild('terminalComponent') terminalComponent!: TerminalComponent;

  showRbox = false;
  showBbox = false;
  terminalTab = 'log';
  selectedTabIndex = 0;

  get topTool() {
    return this.uiService.topTool;
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  // 子应用配置
  subappConfigs = SUBAPP_CONFIGS;

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
    private updateService: UpdateService,
    private npmService: NpmService,
    private router: Router,
    private configService: ConfigService,
    private modal: NzModalService,
    public subappBridge: SubappBridgeService,
    private serialService: SerialService,
    private electronService: ElectronService,
    private translate: TranslateService
  ) {
    // 初始化通用 Bridge 服务提供者
    this.subappBridge.setProvider({
      serialService: this.serialService,
      electronService: this.electronService,
      projectService: this.projectService,
      configService: this.configService,
      uiService: this.uiService,
      translateService: this.translate,
      messageService: this.message
    });
  }

  ngOnInit(): void {
    this.uiService.init();
    this.projectService.init();
    this.updateService.init();
    this.npmService.init();

    // 上传过程中断开串口连接
    this.uiService.stateSubject.subscribe((state) => {
      if (state.state == 'doing' && state.text == '固件上传中...') {
        this.subappBridge.forceDisconnect('serial-monitor');
      }
    });

    // 语言设置变化后，重新加载项目
    window['ipcRenderer'].on('setting-changed', async (event, data) => {
      await this.configService.load();
      if (data.action == 'language-changed' && this.router.url.includes('/main/blockly-editor')) {
        console.log('mainwindow setLanguage', data);
        this.projectService.save();
        setTimeout(() => {
          this.projectService.projectOpen();
        }, 100);
      }
    });
  }

  ngAfterViewInit(): void {
    this.uiService.actionSubject.subscribe((e: any) => {
      // console.log(e);
      switch (e.type) {
        case 'tool':
          if (e.action === 'open') {
            this.showRbox = true;
          } else {
            if (this.topTool === null) {
              this.showRbox = false;
            }
          }
          break;
        case 'bottom-sider':
          if (e.action === 'open') {
            this.showBbox = true;
            this.terminalTab = e.data;
            this.uiService.currentBottomTab = e.data;
            // 根据数据设置选中的tab
            if (e.data === 'log') {
              this.selectedTabIndex = 0;
            } else if (e.data === 'terminal') {
              this.selectedTabIndex = 1;
            }
          } else if (e.action === 'switch-tab') {
            // 切换tab，不改变面板的显示状态
            this.terminalTab = e.data;
            this.uiService.currentBottomTab = e.data;
            if (e.data === 'log') {
              this.selectedTabIndex = 0;
            } else if (e.data === 'terminal') {
              this.selectedTabIndex = 1;
            }
          } else {
            this.showBbox = false;
            this.uiService.currentBottomTab = '';
          }
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });

    this.projectService.stateSubject.subscribe((state) => {
      switch (state) {
        case 'loading':
          // this.loaded = false;
          setTimeout(() => {
            this.message.loading('Project Loading...');
            // this.loaded = true;
          }, 20);
          break;
        case 'loaded':
          this.message.remove();
          this.message.success('Project Loaded');
          break;
        case 'saving':
          this.message.loading('Project Saving...');
          break;
        case 'saved':
          this.message.remove();
          this.message.success('Project Saved');
          break;
        case 'default':
          // this.message.success('Project Closed');
          // this.loaded = false;
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });
  }

  closeRightBox() {
    this.showRbox = false;
  }

  bottomHeight = 210;
  siderWidth = 450;

  onSideResize({ width }: NzResizeEvent): void {
    this.siderWidth = width!;
  }

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 处理底部tab的切换
  onTabChange(index: number): void {
    this.selectedTabIndex = index;
    if (index === 0) {
      this.terminalTab = 'log';
      this.uiService.currentBottomTab = 'log';
    } else if (index === 1) {
      this.terminalTab = 'terminal';
      this.uiService.currentBottomTab = 'terminal';
    }
  }

  // 关闭底部面板
  closeBottomPanel(): void {
    this.showBbox = false;
    this.uiService.terminalIsOpen = false;
    this.uiService.currentBottomTab = '';
  }

  // 清空当前选中的组件
  clearCurrentComponent(): void {
    if (this.selectedTabIndex === 0) {
      // 清空日志
      this.logComponent?.clear();
    } else if (this.selectedTabIndex === 1) {
      // 清空终端
      this.terminalComponent?.clear();
    }
  }

  showFloatSider = false;

  // 监听鼠标位置，当鼠标在右边缘70px范围内时显示浮动侧边栏
  onMouseMove(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const mouseX = event.clientX;
    const rightEdge = rect.right;
    const threshold = 70; // 右边缘阈值距离

    // 当鼠标在右边缘70px范围内时显示浮动侧边栏
    if (rightEdge - mouseX <= threshold) {
      this.showFloatSider = true;
    } else {
      this.showFloatSider = false;
    }
  }

  // 鼠标离开时隐藏浮动侧边栏
  onMouseLeave(): void {
    this.showFloatSider = false;
  }

  exportLog() {
    this.logComponent?.exportData();
  }

  /**
   * 串口监视器子应用连接成功回调
   */
  onSerialMonitorConnected() {
    console.log('[MainWindow] 串口监视器子应用已连接');
    // 如果有当前选中的串口，通知子应用
    if (this.serialService.currentPort) {
      this.subappBridge.setPort('serial-monitor', this.serialService.currentPort);
    }
  }

}

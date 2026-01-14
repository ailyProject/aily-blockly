import { Component, ChangeDetectorRef, ViewChild, ElementRef, HostListener } from '@angular/core';
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
import { SerialMonitorComponent } from '../tools/serial-monitor/serial-monitor.component';
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
import { OnboardingComponent } from '../components/onboarding/onboarding.component';
import { OnboardingService } from '../services/onboarding.service';
import { WebContentsViewService, SubAppBounds } from '../services/web-contents-view.service';
import { SubAppContainerComponent } from '../components/sub-app-container/sub-app-container.component';

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
    SerialMonitorComponent,
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
    ModelStoreComponent,
    OnboardingComponent,
    SubAppContainerComponent
  ],
  templateUrl: './main-window.component.html',
  styleUrl: './main-window.component.scss',
})
export class MainWindowComponent {
  @ViewChild('logComponent') logComponent!: LogComponent;
  @ViewChild('terminalComponent') terminalComponent!: TerminalComponent;
  @ViewChild('rightBox') rightBoxRef!: ElementRef<HTMLElement>;

  showRbox = false;
  showBbox = false;
  terminalTab = 'log';
  selectedTabIndex = 0;

  // 是否使用 WebContentsView 模式
  useWebContentsView = true;

  get topTool() {
    return this.uiService.topTool;
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  // 新手引导相关
  showOnboarding = false;
  onboardingConfig = null;

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
    private onboardingService: OnboardingService,
    private wcvService: WebContentsViewService
  ) { }

  ngOnInit(): void {
    this.uiService.init();
    this.projectService.init();
    this.updateService.init();
    this.npmService.init();

    // 订阅 onboarding 服务
    this.onboardingService.show$.subscribe((show) => {
      this.showOnboarding = show;
      this.cd.detectChanges();
    });
    this.onboardingService.config$.subscribe((config) => {
      this.onboardingConfig = config;
      this.cd.detectChanges();
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
    // 如果使用 WebContentsView 模式，更新子应用边界
    if (this.useWebContentsView) {
      this.updateSubAppBounds();
    }
  }

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 更新所有可见子应用的边界
  private async updateSubAppBounds(): Promise<void> {
    if (!this.useWebContentsView || !this.rightBoxRef) {
      return;
    }

    const updates: { appId: string; bounds: SubAppBounds }[] = [];
    
    for (const tool of this.openToolList) {
      const bounds = this.calculateToolBounds();
      updates.push({ appId: tool, bounds });
    }

    if (updates.length > 0) {
      await this.wcvService.batchUpdateBounds(updates);
    }
  }

  // 计算工具面板的边界
  private calculateToolBounds(): SubAppBounds {
    if (!this.rightBoxRef) {
      return { x: 0, y: 0, width: this.siderWidth, height: 600 };
    }

    const element = this.rightBoxRef.nativeElement;
    const rect = element.getBoundingClientRect();
    
    // 获取标题栏高度（macOS）
    const titleBarHeight = (window as any).electronAPI?.platform?.isMacOS ? 28 : 0;

    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + titleBarHeight),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  // 窗口大小变化时更新子应用边界
  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.useWebContentsView) {
      this.updateSubAppBounds();
    }
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

  // 新手引导关闭事件
  onOnboardingClosed() {
    this.onboardingService.close();
  }

  // 新手引导完成事件
  onOnboardingCompleted() {
    this.onboardingService.complete();
  }

}

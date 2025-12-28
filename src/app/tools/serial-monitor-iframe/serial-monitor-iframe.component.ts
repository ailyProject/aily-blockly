import { Component, ElementRef, OnDestroy, OnInit, ViewChild, AfterViewInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { SerialMonitorBridgeService } from './serial-monitor-bridge.service';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { UiService } from '../../services/ui.service';
import { SerialService } from '../../services/serial.service';
import { NoticeService } from '../../services/notice.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-serial-monitor-iframe',
  standalone: true,
  imports: [CommonModule, ToolContainerComponent, SubWindowComponent],
  template: `
    @if (currentUrl == "/serial-monitor") {
    <app-sub-window [title]="'MONITOR'" [winBtns]="['go-main', 'minimize', 'maximize', 'close']">
      <ng-container *ngTemplateOutlet="iframeTemplate"></ng-container>
    </app-sub-window>
    } @else {
    <app-tool-container [title]="'MONITOR'" [path]="'/serial-monitor'" (closeEvent)="close()">
      <ng-container *ngTemplateOutlet="iframeTemplate"></ng-container>
    </app-tool-container>
    }
    
    <ng-template #iframeTemplate>
      <div class="iframe-container">
        @if (loadError) {
        <div class="error-container">
          <div class="error-icon">
            <i class="fa-light fa-triangle-exclamation"></i>
          </div>
          <div class="error-title">加载子应用失败</div>
          <div class="error-message">{{ loadError }}</div>
          <button class="retry-btn" (click)="retryLoad()">
            <i class="fa-light fa-rotate-right"></i>
            重新加载
          </button>
        </div>
        } @else {
        <iframe 
          #serialMonitorIframe
          [src]="iframeSrc"
          frameborder="0"
          (load)="onIframeLoad()"
          (error)="onIframeError($event)">
        </iframe>
        }
      </div>
    </ng-template>
  `,
  styles: [`
    .iframe-container {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    
    .error-container {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #1a1a1a;
      color: #999;
      gap: 12px;
    }
    
    .error-icon {
      font-size: 48px;
      color: #ff6b6b;
    }
    
    .error-title {
      font-size: 16px;
      font-weight: 500;
      color: #e0e0e0;
    }
    
    .error-message {
      font-size: 12px;
      color: #888;
      max-width: 300px;
      text-align: center;
      word-break: break-all;
    }
    
    .retry-btn {
      margin-top: 8px;
      padding: 8px 16px;
      border: 1px solid #444;
      border-radius: 4px;
      background: #2a2a2a;
      color: #e0e0e0;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    
    .retry-btn:hover {
      background: #3a3a3a;
      border-color: #555;
    }
  `]
})
export class SerialMonitorIframeComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('serialMonitorIframe') iframeRef!: ElementRef<HTMLIFrameElement>;
  
  iframeSrc: SafeResourceUrl;
  currentUrl: string = '';
  loadError: string | null = null;
  private connectionTimeout: any = null;
  private iframeUrl: string = '';
  
  private subscriptions: Subscription[] = [];
  
  constructor(
    private sanitizer: DomSanitizer,
    private bridgeService: SerialMonitorBridgeService,
    private router: Router,
    private uiService: UiService,
    private serialService: SerialService,
    private noticeService: NoticeService,
    private cd: ChangeDetectorRef
  ) {
    // 开发模式下使用 localhost:4201，生产模式下使用相对路径
    const isDev = window.location.port === '4200';
    this.iframeUrl = isDev 
      ? 'http://localhost:4201' 
      : './serial-monitor-app/index.html';
    
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(this.iframeUrl);
  }
  
  ngOnInit() {
    this.currentUrl = this.router.url;
    
    // 上传过程中断开串口连接
    const stateSub = this.uiService.stateSubject.subscribe((state) => {
      if (state.state == 'doing' && state.text == '固件上传中...') {
        this.bridgeService.forceDisconnect();
      }
    });
    this.subscriptions.push(stateSub);
    
    // 监听 Electron 的 iframe 加载失败事件
    this.setupIframeErrorListener();
  }
  
  private setupIframeErrorListener() {
    // 检查是否在 Electron 环境中
    if ((window as any).electronAPI?.ipcRenderer) {
      (window as any).electronAPI.ipcRenderer.on('iframe-load-error', (_event: any, data: any) => {
        // 检查是否是当前 iframe 的错误
        if (data.url && data.url.includes('4201')) {
          console.error('[SerialMonitorIframe] Electron reported iframe load error:', data);
          const errorMsg = `加载失败: ${data.errorDescription || 'ERR_CONNECTION_REFUSED'}`;
          this.loadError = errorMsg;
          this.noticeService.update({
            state: 'error',
            title: '子应用加载失败',
            text: `串口监视器加载失败`,
            detail: `无法连接到 ${data.url}，错误: ${data.errorDescription}`,
            setTimeout: 5000
          });
          this.cd.detectChanges();
        }
      });
    }
  }
  
  ngAfterViewInit() {
    // 设置连接超时检测
    this.startConnectionTimeout();
  }
  
  private startConnectionTimeout() {
    // 清除之前的超时
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    
    // 10秒超时检测
    this.connectionTimeout = setTimeout(() => {
      if (!this.bridgeService.isConnectionReady()) {
        const errorMsg = `连接超时: 无法连接到 ${this.iframeUrl}，请确保子应用服务已启动`;
        this.loadError = errorMsg;
        this.noticeService.update({
          state: 'error',
          title: '子应用加载失败',
          text: errorMsg,
          detail: `串口监视器子应用 (${this.iframeUrl}) 连接超时，请检查子应用服务是否已启动`,
          setTimeout: 5000
        });
        this.cd.detectChanges();
      }
    }, 10000);
  }
  
  async onIframeLoad() {
    // 清除超时检测
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    if (this.iframeRef) {
      try {
        // 检查 iframe 是否可访问（跨域检测）
        const iframe = this.iframeRef.nativeElement;
        
        // 检测 iframe 是否加载了有效内容
        // 如果 contentWindow 存在但无法访问 document，可能是跨域或加载失败
        try {
          // 尝试访问 iframe 内容，如果是空白页或错误页会抛出异常
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          // 检查是否是空白页或错误页
          if (!iframeDoc || iframeDoc.body?.innerHTML === '' || 
              iframeDoc.title?.includes('ERR_') || 
              iframeDoc.body?.innerText?.includes('ERR_CONNECTION_REFUSED')) {
            throw new Error('子应用服务未启动或无法访问');
          }
        } catch (e) {
          // 跨域情况下无法访问 contentDocument，这是正常的
          // 但如果 contentWindow 不存在，说明加载失败
          if (!iframe.contentWindow) {
            throw new Error('iframe 加载失败，contentWindow 不存在');
          }
        }
        
        // 尝试初始化 penpal 连接
        await this.bridgeService.initConnection(this.iframeRef);
        
        // 连接成功，清除错误状态
        this.loadError = null;
        
        // 如果有当前选中的串口，通知子应用
        if (this.serialService.currentPort) {
          this.bridgeService.setPort(this.serialService.currentPort);
        }
      } catch (error: any) {
        console.error('[SerialMonitorIframe] Connection failed:', error);
        const errorMsg = `Penpal 连接失败: ${error.message || error}`;
        this.loadError = errorMsg;
        this.noticeService.update({
          state: 'error',
          title: '子应用连接失败',
          text: errorMsg,
          detail: `串口监视器子应用通信失败: ${error.message || error}`,
          setTimeout: 5000
        });
        this.cd.detectChanges();
      }
    }
  }
  
  onIframeError(event: Event) {
    console.error('[SerialMonitorIframe] Iframe load error:', event);
    const errorMsg = `加载失败: 无法加载 ${this.iframeUrl}`;
    this.loadError = errorMsg;
    this.noticeService.update({
      state: 'error',
      title: '子应用加载失败',
      text: errorMsg,
      detail: `串口监视器子应用加载失败，请检查子应用服务是否已启动`,
      setTimeout: 5000
    });
    this.cd.detectChanges();
  }
  
  retryLoad() {
    this.loadError = null;
    this.cd.detectChanges();
    
    // 重新触发 iframe 加载
    setTimeout(() => {
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(this.iframeUrl);
      this.startConnectionTimeout();
      this.cd.detectChanges();
    }, 100);
  }
  
  close() {
    this.uiService.closeTool('serial-monitor');
  }
  
  ngOnDestroy() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    this.bridgeService.destroy();
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }
}

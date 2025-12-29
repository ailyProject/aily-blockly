import { 
  Component, 
  ElementRef, 
  OnDestroy, 
  OnInit, 
  ViewChild, 
  AfterViewInit, 
  ChangeDetectorRef,
  Input,
  Output,
  EventEmitter,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NoticeService } from '../../services/notice.service';
import { SubAppConfig, getSubAppUrl, SubAppBridge } from './subapp-config';

/**
 * 通用子应用容器组件
 * 用于在 iframe 中加载子应用，并处理加载状态和错误
 */
@Component({
  selector: 'app-subapp-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="subapp-container">
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
        #subappIframe
        [src]="iframeSrc"
        frameborder="0"
        (load)="onIframeLoad()"
        (error)="onIframeError($event)">
      </iframe>
      }
    </div>
  `,
  styles: [`
    .subapp-container {
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
export class SubappContainerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('subappIframe') iframeRef!: ElementRef<HTMLIFrameElement>;
  
  /** 子应用配置 */
  @Input() config!: SubAppConfig;
  
  /** Bridge 服务实例 */
  @Input() bridge!: SubAppBridge;
  
  /** 连接成功事件 */
  @Output() connected = new EventEmitter<void>();
  
  /** 连接失败事件 */
  @Output() connectionError = new EventEmitter<string>();
  
  /** iframe 引用就绪事件 */
  @Output() iframeReady = new EventEmitter<ElementRef<HTMLIFrameElement>>();
  
  iframeSrc!: SafeResourceUrl;
  loadError: string | null = null;
  
  private connectionTimeout: any = null;
  private subappUrl: string = '';
  private ipcErrorHandler: any = null;
  
  private sanitizer = inject(DomSanitizer);
  private noticeService = inject(NoticeService);
  private cd = inject(ChangeDetectorRef);
  
  ngOnInit() {
    if (!this.config) {
      console.error('[SubappContainer] config is required');
      return;
    }
    
    this.subappUrl = getSubAppUrl(this.config);
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(this.subappUrl);
    
    // 监听 Electron 的 iframe 加载失败事件
    this.setupIframeErrorListener();
  }
  
  private setupIframeErrorListener() {
    if ((window as any).electronAPI?.ipcRenderer) {
      this.ipcErrorHandler = (_event: any, data: any) => {
        // 检查是否是当前子应用的错误
        if (data.url && data.url.includes(String(this.config.devPort))) {
          console.error(`[SubappContainer:${this.config.id}] Electron reported iframe load error:`, data);
          const errorMsg = `加载失败: ${data.errorDescription || 'ERR_CONNECTION_REFUSED'}`;
          this.setError(errorMsg, `${this.config.name}加载失败`, 
            `无法连接到 ${data.url}，错误: ${data.errorDescription}`);
        }
      };
      
      (window as any).electronAPI.ipcRenderer.on('iframe-load-error', this.ipcErrorHandler);
    }
  }
  
  ngAfterViewInit() {
    this.startConnectionTimeout();
  }
  
  private startConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    
    const timeout = this.config.connectionTimeout || 10000;
    
    this.connectionTimeout = setTimeout(() => {
      if (this.bridge && !this.bridge.isConnectionReady(this.config.id)) {
        const errorMsg = `连接超时: 无法连接到 ${this.subappUrl}，请确保子应用服务已启动`;
        this.setError(errorMsg, `${this.config.name}连接超时`,
          `${this.config.name} (${this.subappUrl}) 连接超时，请检查子应用服务是否已启动`);
      }
    }, timeout);
  }
  
  private setError(errorMsg: string, title: string, detail: string) {
    this.loadError = errorMsg;
    this.noticeService.update({
      state: 'error',
      title: title,
      text: errorMsg,
      detail: detail,
      setTimeout: 5000
    });
    this.connectionError.emit(errorMsg);
    this.cd.detectChanges();
  }
  
  async onIframeLoad() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    if (this.iframeRef && this.bridge) {
      try {
        // 检测 iframe 是否加载了有效内容
        const iframe = this.iframeRef.nativeElement;
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc || iframeDoc.body?.innerHTML === '' || 
              iframeDoc.title?.includes('ERR_') || 
              iframeDoc.body?.innerText?.includes('ERR_CONNECTION_REFUSED')) {
            throw new Error('子应用服务未启动或无法访问');
          }
        } catch (e) {
          if (!iframe.contentWindow) {
            throw new Error('iframe 加载失败，contentWindow 不存在');
          }
        }
        
        // 初始化 Bridge 连接，传递 config 以便识别子应用
        await this.bridge.initConnection(this.iframeRef, this.config);
        
        // 连接成功
        this.loadError = null;
        this.connected.emit();
        this.iframeReady.emit(this.iframeRef);
        
      } catch (error: any) {
        console.error(`[SubappContainer:${this.config.id}] Connection failed:`, error);
        this.setError(
          `连接失败: ${error.message || error}`,
          `${this.config.name}连接失败`,
          `${this.config.name}通信失败: ${error.message || error}`
        );
      }
    }
  }
  
  onIframeError(event: Event) {
    console.error(`[SubappContainer:${this.config.id}] Iframe load error:`, event);
    this.setError(
      `加载失败: 无法加载 ${this.subappUrl}`,
      `${this.config.name}加载失败`,
      `${this.config.name}加载失败，请检查子应用服务是否已启动`
    );
  }
  
  retryLoad() {
    this.loadError = null;
    this.cd.detectChanges();
    
    setTimeout(() => {
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(this.subappUrl);
      this.startConnectionTimeout();
      this.cd.detectChanges();
    }, 100);
  }
  
  ngOnDestroy() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    
    // 注意：Electron IPC 监听器需要在应用层面管理，这里只清理引用
    this.ipcErrorHandler = null;
  }
}

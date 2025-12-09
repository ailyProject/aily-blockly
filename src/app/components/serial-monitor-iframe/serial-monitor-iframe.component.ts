import { Component, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { IframeBridgeService } from '../../services/iframe-bridge.service';
import { Subscription } from 'rxjs';

/**
 * Serial Monitor Iframe 容器组件
 * 替换原有的 app-serial-monitor 组件
 */
@Component({
  selector: 'app-serial-monitor-iframe',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="serial-monitor-iframe-container">
      <iframe
        #serialIframe
        [src]="safeIframeUrl"
        frameborder="0"
        (load)="onIframeLoad()"
      ></iframe>
      @if (loading) {
        <div class="loading-overlay">
          <div class="loading-text">加载串口监视器...</div>
        </div>
      }
    </div>
  `,
  styles: [`
    .serial-monitor-iframe-container {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(255, 255, 255, 0.9);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .loading-text {
      margin-top: 16px;
      color: #666;
    }
  `]
})
export class SerialMonitorIframeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('serialIframe') iframeElement!: ElementRef<HTMLIFrameElement>;

  // iframe URL - 开发环境和生产环境不同
  safeIframeUrl: SafeResourceUrl;
  loading = true;

  private subscriptions: Subscription[] = [];

  constructor(
    private iframeBridge: IframeBridgeService,
    private sanitizer: DomSanitizer
  ) {
    // 使用 DomSanitizer 信任 iframe URL
    this.safeIframeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.getIframeUrl());
  }

  ngAfterViewInit() {
    // 设置 iframe 引用
    if (this.iframeElement) {
      this.iframeBridge.setIframeRef(this.iframeElement.nativeElement);
    }

    // 监听来自 iframe 的请求
    this.setupMessageHandlers();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  onIframeLoad() {
    console.log('Serial monitor iframe loaded');
    
    // 延迟隐藏加载动画,确保 iframe 内容已渲染
    setTimeout(() => {
      this.loading = false;
    }, 500);
  }

  private getIframeUrl(): string {
    // 开发环境
    if (!window.electronAPI || (window as any).location.hostname === 'localhost') {
      return 'http://localhost:4201';
    }
    
    // 生产环境 - Electron
    // 假设子应用构建到 dist/serial-monitor-app
    return './serial-monitor-app/index.html';
  }

  private setupMessageHandlers() {
    // 监听 iframe 就绪
    this.subscriptions.push(
      this.iframeBridge.onMessage('IFRAME_READY').subscribe(() => {
        console.log('Serial monitor iframe ready');
        this.onIframeReady();
      })
    );

    // 监听串口请求
    this.subscriptions.push(
      this.iframeBridge.onMessage('SERIAL_REQUEST').subscribe(async (msg) => {
        await this.handleSerialRequest(msg);
      })
    );

    // 监听关闭请求
    this.subscriptions.push(
      this.iframeBridge.onMessage('REQUEST_CLOSE').subscribe(() => {
        this.handleCloseRequest();
      })
    );

    // 监听错误通知
    this.subscriptions.push(
      this.iframeBridge.onMessage('ERROR').subscribe((msg) => {
        console.error('Serial monitor error:', msg.data);
      })
    );
  }

  private onIframeReady() {
    // iframe 准备好后,发送初始数据
    // 可以从相关服务获取项目数据等
    // this.iframeBridge.notifyProjectUpdate(projectData);
  }

  private async handleSerialRequest(msg: any) {
    const { action, options, data, requestId } = msg;

    try {
      let result;

      switch (action) {
        case 'list':
          result = await this.getSerialPorts();
          break;
        case 'connect':
          result = await this.connectSerial(options);
          break;
        case 'disconnect':
          result = await this.disconnectSerial();
          break;
        case 'send':
          result = await this.sendSerialData(data);
          break;
        default:
          throw new Error(`Unknown serial action: ${action}`);
      }

      // 发送响应
      this.iframeBridge.sendMessage({
        type: 'SERIAL_REQUEST',
        requestId,
        data: result
      });
    } catch (error: any) {
      // 发送错误响应
      this.iframeBridge.sendMessage({
        type: 'SERIAL_REQUEST',
        requestId,
        data: { success: false, error: error.message }
      });
    }
  }

  private async getSerialPorts(): Promise<any[]> {
    if (window.electronAPI?.SerialPort) {
      const result = await window.electronAPI.SerialPort.list();
      // list() 直接返回端口数组
      return Array.isArray(result) ? result : (result as any)?.data || [];
    }
    return [];
  }

  private async connectSerial(options: any): Promise<boolean> {
    if (window.electronAPI?.SerialPort?.connect) {
      const result = await window.electronAPI.SerialPort.connect(options);
      
      if (result?.success && window.electronAPI.SerialPort.onData) {
        // 监听串口数据并转发到 iframe
        window.electronAPI.SerialPort.onData((data: any) => {
          this.iframeBridge.forwardSerialData(data);
        });
      }
      
      return result?.success || false;
    }
    return false;
  }

  private async disconnectSerial(): Promise<boolean> {
    if (window.electronAPI?.SerialPort?.disconnect) {
      const result = await window.electronAPI.SerialPort.disconnect();
      return result?.success || false;
    }
    return false;
  }

  private async sendSerialData(data: any): Promise<boolean> {
    if (window.electronAPI?.SerialPort?.send) {
      const result = await window.electronAPI.SerialPort.send(data);
      return result?.success || false;
    }
    return false;
  }

  private handleCloseRequest() {
    // 通知父组件关闭
    // 或者通过路由导航等方式处理
    console.log('Close request from serial monitor');
  }
}

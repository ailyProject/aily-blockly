import { Component, ElementRef, OnDestroy, OnInit, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { SerialMonitorBridgeService } from './serial-monitor-bridge.service';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { UiService } from '../../services/ui.service';
import { SerialService } from '../../services/serial.service';
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
        <iframe 
          #serialMonitorIframe
          [src]="iframeSrc"
          frameborder="0"
          (load)="onIframeLoad()">
        </iframe>
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
  `]
})
export class SerialMonitorIframeComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('serialMonitorIframe') iframeRef!: ElementRef<HTMLIFrameElement>;
  
  iframeSrc: SafeResourceUrl;
  currentUrl: string = '';
  
  private subscriptions: Subscription[] = [];
  
  constructor(
    private sanitizer: DomSanitizer,
    private bridgeService: SerialMonitorBridgeService,
    private router: Router,
    private uiService: UiService,
    private serialService: SerialService
  ) {
    // 开发模式下使用 localhost:4201，生产模式下使用相对路径
    const isDev = window.location.port === '4200';
    const iframeUrl = isDev 
      ? 'http://localhost:4201' 
      : './serial-monitor-app/index.html';
    
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(iframeUrl);
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
  }
  
  ngAfterViewInit() {
    // iframe 加载完成后初始化连接
  }
  
  async onIframeLoad() {
    if (this.iframeRef) {
      await this.bridgeService.initConnection(this.iframeRef);
      
      // 如果有当前选中的串口，通知子应用
      if (this.serialService.currentPort) {
        this.bridgeService.setPort(this.serialService.currentPort);
      }
    }
  }
  
  close() {
    this.uiService.closeTool('serial-monitor');
  }
  
  ngOnDestroy() {
    this.bridgeService.destroy();
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }
}

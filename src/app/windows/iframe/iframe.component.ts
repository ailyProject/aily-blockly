import {
  Component,
  Inject,
  Input,
  OnDestroy,
  OnInit,
  Optional,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { Connection, connect, WindowMessenger } from 'penpal';

import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ElectronService } from '@core/platform/public-api';

export interface IframeModalData {
  /** URL loaded by this generic iframe window. */
  url: string;
  /** Opaque initialization data supplied to the embedded application. */
  data?: unknown;
  /** Window title. */
  title?: string;
}

/**
 * Generic iframe surface used by independent web tools such as the component
 * viewer. It deliberately has no Connection Graph persistence, Agent, Runtime,
 * or Simulator bridge. Simulator surfaces are hosted by ChildToolHostComponent.
 */
@Component({
  selector: 'app-iframe',
  imports: [SubWindowComponent, CommonModule],
  templateUrl: './iframe.component.html',
  styleUrl: './iframe.component.scss',
})
export class IframeComponent implements OnInit, OnDestroy {
  @Input() url?: string;
  @Input() embedded?: boolean;

  iframeSrc: SafeResourceUrl = '';
  private iframeData: unknown;
  private allowedOrigins: string[] = ['*'];
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;
  private initDataCleanup: (() => void) | null = null;

  windowTitle = '';
  showEmptyState = false;
  isLoading = true;
  isComponentViewerWindow = false;

  constructor(
    @Optional() @Inject(NZ_MODAL_DATA) public data: IframeModalData | null,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private electronService: ElectronService,
  ) {
    if (this.data) {
      if (this.data.url) this.applyUrl(this.data.url);
      if (this.data.data !== undefined) this.iframeData = this.data.data;
      if (this.data.title) this.windowTitle = this.data.title;
    }
  }

  async ngOnInit(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (this.embedded) {
      if (this.url) this.applyUrl(this.url);
      return;
    }

    if (!this.data) {
      this.route.queryParams.subscribe((params) => {
        const url = params['url'];
        if (url) this.applyUrl(url);
      });

      if (this.electronService.isElectron && window['subWindow']?.onInitData) {
        this.initDataCleanup = window['subWindow'].onInitData(
          (initData: IframeModalData) => this.handleInitData(initData),
        );
      }
    }
  }

  onIframeLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    if (!iframe.contentWindow) {
      this.handleLoadError();
      return;
    }

    this.penpalConnection?.destroy();
    this.penpalConnection = null;
    this.remoteApi = null;
    void this.startPenpalConnection(iframe);
  }

  handleLoadError(): void {
    this.isLoading = false;
    this.showEmptyState = true;
  }

  async callRemote(method: string, ...args: any[]): Promise<any> {
    if (!this.remoteApi || typeof this.remoteApi[method] !== 'function') {
      console.warn(`远程方法 ${method} 不可用`);
      return null;
    }
    return this.remoteApi[method](...args);
  }

  ngOnDestroy(): void {
    this.penpalConnection?.destroy();
    this.penpalConnection = null;
    this.remoteApi = null;
    this.initDataCleanup?.();
    this.initDataCleanup = null;
  }

  private applyUrl(url: string): void {
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    try {
      this.allowedOrigins = [new URL(url).origin];
    } catch {
      this.allowedOrigins = ['*'];
    }
    this.isComponentViewerWindow = url.includes('component-viewer');
  }

  private handleInitData(initData: IframeModalData): void {
    if (!initData) return;
    if (initData.title) this.windowTitle = initData.title;
    if (initData.url) this.applyUrl(initData.url);
    this.iframeData = initData.data !== undefined ? initData.data : initData;
  }

  private async startPenpalConnection(iframe: HTMLIFrameElement): Promise<void> {
    try {
      const messenger = new WindowMessenger({
        remoteWindow: iframe.contentWindow!,
        allowedOrigins: this.allowedOrigins,
      });
      this.penpalConnection = connect({
        messenger,
        methods: {
          initedComponentViewer: () => this.pushDataToRemote(),
        },
      });
      this.remoteApi = await this.penpalConnection.promise;
      this.isLoading = false;
      this.showEmptyState = false;

      // Compatibility for the current component viewer, which may call the
      // parent or wait for one initial parent push depending on its version.
      if (this.isComponentViewerWindow) {
        setTimeout(() => void this.pushDataToRemote(), 10);
      }
    } catch (error) {
      console.error('Penpal 连接失败:', error);
      this.handleLoadError();
    }
  }

  private async pushDataToRemote(): Promise<void> {
    if (!this.remoteApi || typeof this.remoteApi['receiveData'] !== 'function') return;
    try {
      await this.remoteApi['receiveData'](this.iframeData);
    } catch (error) {
      console.warn('推送数据给子页面失败:', error);
    }
  }
}

import { Injectable, NgZone } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { BehaviorSubject, Subject } from 'rxjs';
import { ParentMethods, ChildMethods, DataItem, QuickSendItem, SerialConfig, PortInfo } from './types';

@Injectable({
  providedIn: 'root'
})
export class PenpalService {
  private parentMethods: RemoteProxy<ParentMethods> | null = null;
  private connection: Connection<ParentMethods> | null = null;
  private connectionReady = new BehaviorSubject<boolean>(false);

  // 用于向组件广播事件
  serialDataReceived = new Subject<DataItem>();
  connectionStatusChanged = new Subject<boolean>();
  portChanged = new Subject<string>();
  baudRateChanged = new Subject<string>();
  clearDataRequested = new Subject<void>();
  forceDisconnectRequested = new Subject<void>();
  quickSendListUpdated = new Subject<QuickSendItem[]>();

  constructor(private ngZone: NgZone) {
    this.initConnection();
  }

  private async initConnection() {
    try {
      const childMethods: ChildMethods = {
        onSerialData: (data: DataItem) => {
          this.ngZone.run(() => {
            this.serialDataReceived.next(data);
          });
        },
        onConnectionStatusChange: (connected: boolean) => {
          this.ngZone.run(() => {
            this.connectionStatusChanged.next(connected);
          });
        },
        setPort: (port: string) => {
          this.ngZone.run(() => {
            this.portChanged.next(port);
          });
        },
        setBaudRate: (baudRate: string) => {
          this.ngZone.run(() => {
            this.baudRateChanged.next(baudRate);
          });
        },
        clearData: () => {
          this.ngZone.run(() => {
            this.clearDataRequested.next();
          });
        },
        forceDisconnect: () => {
          this.ngZone.run(() => {
            this.forceDisconnectRequested.next();
          });
        },
        updateQuickSendList: (list: QuickSendItem[]) => {
          this.ngZone.run(() => {
            this.quickSendListUpdated.next(list);
          });
        }
      };

      // penpal 7.x 使用 WindowMessenger + connect
      const messenger = new WindowMessenger({
        remoteWindow: window.parent,
        allowedOrigins: ['*'] // 允许任意来源（Electron 环境）
      });

      this.connection = connect<ParentMethods>({
        messenger,
        methods: childMethods
      });

      this.parentMethods = await this.connection.promise;
      this.connectionReady.next(true);
      console.log('[SerialMonitorApp] Penpal connection established');
    } catch (error) {
      console.error('[SerialMonitorApp] Failed to connect to parent:', error);
    }
  }

  /**
   * 等待连接就绪
   */
  async waitForConnection(): Promise<void> {
    if (this.connectionReady.value) return;
    return new Promise((resolve) => {
      const sub = this.connectionReady.subscribe((ready) => {
        if (ready) {
          sub.unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * 检查连接是否就绪
   */
  isConnected(): boolean {
    return this.connectionReady.value && this.parentMethods !== null;
  }

  // ============ 串口操作 ============

  async getPortsList(): Promise<PortInfo[]> {
    await this.waitForConnection();
    return this.parentMethods!.getPortsList();
  }

  async connect(config: SerialConfig): Promise<boolean> {
    await this.waitForConnection();
    return this.parentMethods!.connect(config);
  }

  async disconnect(): Promise<boolean> {
    await this.waitForConnection();
    return this.parentMethods!.disconnect();
  }

  async sendData(data: string, mode?: string, ignoreEnd?: boolean): Promise<boolean> {
    await this.waitForConnection();
    return this.parentMethods!.sendData(data, mode, ignoreEnd);
  }

  async sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    await this.waitForConnection();
    return this.parentMethods!.sendSignal(signalType, state);
  }

  // ============ 文件操作 ============

  async exportData(content: string): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.exportData(content);
  }

  // ============ 配置操作 ============

  async getQuickSendList(): Promise<QuickSendItem[]> {
    await this.waitForConnection();
    return this.parentMethods!.getQuickSendList();
  }

  async saveQuickSendList(list: QuickSendItem[]): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.saveQuickSendList(list);
  }

  // ============ UI 操作 ============

  async closePanel(): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.closePanel();
  }

  async openInNewWindow(): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.openInNewWindow();
  }

  // ============ 翻译 ============

  async translate(key: string): Promise<string> {
    await this.waitForConnection();
    return this.parentMethods!.translate(key);
  }

  // ============ 消息提示 ============

  async showMessage(type: 'success' | 'error' | 'warning' | 'info', content: string): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.showMessage(type, content);
  }

  // ============ 开发板信息 ============

  async getCurrentBoard(): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.getCurrentBoard();
  }
}

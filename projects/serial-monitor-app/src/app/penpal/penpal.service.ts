import { Injectable, NgZone } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { BehaviorSubject, Subject } from 'rxjs';
import { ParentMethods, ChildMethods, DataItem, QuickSendItem, PortInfo } from './types';

@Injectable({
  providedIn: 'root'
})
export class PenpalService {
  private parentMethods: RemoteProxy<ParentMethods> | null = null;
  private connection: Connection<ParentMethods> | null = null;
  private connectionReady = new BehaviorSubject<boolean>(false);

  // 用于向组件广播来自父窗口的事件
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
        // 设置当前串口
        setPort: (port: string) => {
          this.ngZone.run(() => {
            this.portChanged.next(port);
          });
        },
        // 设置波特率
        setBaudRate: (baudRate: string) => {
          this.ngZone.run(() => {
            this.baudRateChanged.next(baudRate);
          });
        },
        // 清空数据
        clearData: () => {
          this.ngZone.run(() => {
            this.clearDataRequested.next();
          });
        },
        // 强制断开连接（上传固件时）
        forceDisconnect: () => {
          this.ngZone.run(() => {
            this.forceDisconnectRequested.next();
          });
        },
        // 更新快捷发送列表
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

  // ============ 通用 Electron API ============

  /**
   * 调用 IPC 方法
   */
  async invokeIpc(channel: string, ...args: any[]): Promise<any> {
    await this.waitForConnection();
    return this.parentMethods!.invokeIpc(channel, ...args);
  }

  /**
   * 获取串口列表
   */
  async getSerialPorts(): Promise<PortInfo[]> {
    await this.waitForConnection();
    return this.parentMethods!.getSerialPorts();
  }

  // ============ 文件操作 ============

  async readFile(path: string): Promise<string> {
    await this.waitForConnection();
    return this.parentMethods!.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.writeFile(path, content);
  }

  async selectFolderSaveAs(options: any): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.selectFolderSaveAs(options);
  }

  // ============ UI 操作 ============

  async closeTool(toolId: string): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.closeTool(toolId);
  }

  async closePanel(): Promise<void> {
    return this.closeTool('serial-monitor');
  }

  async openInNewWindow(route?: string): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.openInNewWindow(route || '/serial-monitor');
  }

  async showMessage(type: 'success' | 'error' | 'warning' | 'info', content: string): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.showMessage(type, content);
  }

  // ============ 翻译 ============

  async translate(key: string): Promise<string> {
    await this.waitForConnection();
    return this.parentMethods!.translate(key);
  }

  // ============ 项目/配置 ============

  async getCurrentProjectPath(): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.getCurrentProjectPath();
  }

  async getCurrentBoard(): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.getCurrentBoard();
  }

  async getCurrentPort(): Promise<string | null> {
    await this.waitForConnection();
    return this.parentMethods!.getCurrentPort();
  }

  async getConfig(key: string): Promise<any> {
    await this.waitForConnection();
    return this.parentMethods!.getConfig(key);
  }

  async saveConfig(key: string, value: any): Promise<void> {
    await this.waitForConnection();
    return this.parentMethods!.saveConfig(key, value);
  }
}

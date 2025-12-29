import { Injectable, ElementRef } from '@angular/core';
import { connect, WindowMessenger, RemoteProxy, Connection } from 'penpal';
import { BehaviorSubject } from 'rxjs';
import { SubAppBridge, SubAppConfig } from './subapp-config';

/**
 * 通用子应用方法接口
 * 子应用需要实现这些基础方法
 */
export interface CommonChildMethods {
  [key: string]: ((...args: any[]) => any) | CommonChildMethods;
}

/**
 * 方法注册表类型
 */
export type MethodsRegistry = { [key: string]: (...args: any[]) => any };

/**
 * Bridge 服务提供者接口
 * 用于注入具体的服务实现
 */
export interface BridgeServiceProvider {
  serialService: any;
  electronService: any;
  projectService: any;
  configService: any;
  uiService: any;
  translateService: any;
  messageService: any;
}

/**
 * 通用子应用桥接服务
 * 
 * 设计理念：
 * 1. 提供一套通用的基础方法（Electron IPC、翻译、消息等）
 * 2. 允许各子应用注册自己的业务方法
 * 3. 一个服务实例管理所有子应用的连接
 * 
 * 使用方式：
 * 1. 在应用启动时调用 setProvider() 设置服务提供者
 * 2. 使用 registerMethods() 注册子应用特定的方法
 * 3. SubappContainerComponent 自动调用 initConnection()
 */
@Injectable({
  providedIn: 'root'
})
export class SubappBridgeService implements SubAppBridge {
  private connections = new Map<string, Connection<CommonChildMethods>>();
  private childMethodsMap = new Map<string, RemoteProxy<CommonChildMethods>>();
  private connectionReady = new Map<string, BehaviorSubject<boolean>>();
  
  /** 各子应用的自定义方法注册表 */
  private customMethods = new Map<string, MethodsRegistry>();
  
  private provider!: BridgeServiceProvider;
  
  /**
   * 初始化服务提供者
   */
  setProvider(provider: BridgeServiceProvider): void {
    this.provider = provider;
  }
  
  /**
   * 注册子应用的自定义方法
   * 
   * @param appId 子应用 ID
   * @param methods 方法注册表
   * 
   * @example
   * ```ts
   * bridgeService.registerMethods('serial-monitor', {
   *   connect: (config) => this.serialService.connect(config),
   *   disconnect: () => this.serialService.disconnect(),
   * });
   * ```
   */
  registerMethods(appId: string, methods: MethodsRegistry): void {
    const existing = this.customMethods.get(appId) || {};
    this.customMethods.set(appId, { ...existing, ...methods });
  }
  
  /**
   * 初始化与子应用的连接
   */
  async initConnection(iframeRef: ElementRef<HTMLIFrameElement>, config?: SubAppConfig): Promise<void> {
    const appId = config?.id || 'default';
    
    // 销毁已有连接
    const existingConnection = this.connections.get(appId);
    if (existingConnection) {
      existingConnection.destroy();
    }
    
    // 合并通用方法和子应用自定义方法
    const parentMethods = this.createParentMethods(appId);
    
    // 建立 penpal 连接
    const messenger = new WindowMessenger({
      remoteWindow: iframeRef.nativeElement.contentWindow!,
      allowedOrigins: ['*']
    });
    
    const connection = connect<CommonChildMethods>({
      messenger,
      methods: parentMethods
    });
    
    this.connections.set(appId, connection);
    
    if (!this.connectionReady.has(appId)) {
      this.connectionReady.set(appId, new BehaviorSubject<boolean>(false));
    }
    
    try {
      const childMethods = await connection.promise;
      this.childMethodsMap.set(appId, childMethods);
      this.connectionReady.get(appId)!.next(true);
      console.log(`[SubappBridge] Connection established for ${appId}`);
    } catch (error) {
      console.error(`[SubappBridge] Failed to connect to ${appId}:`, error);
      throw error;
    }
  }
  
  /**
   * 创建暴露给子应用的方法（通用 + 自定义）
   */
  private createParentMethods(appId: string): MethodsRegistry {
    // 通用基础方法
    const commonMethods: MethodsRegistry = {
      // === Electron API ===
      invokeIpc: async (channel: string, ...args: any[]) => {
        return window['ipcRenderer'].invoke(channel, ...args);
      },
      
      getSerialPorts: async () => {
        return this.provider?.serialService?.getSerialPorts() || [];
      },
      
      createSerialPort: (options: any) => {
        return (window as any).electronAPI?.SerialPort?.create(options);
      },
      
      readFile: async (path: string) => {
        return this.provider?.electronService?.readFile(path);
      },
      
      writeFile: async (path: string, content: string) => {
        return this.provider?.electronService?.writeFile(path, content);
      },
      
      selectFolderSaveAs: async (options: any) => {
        return window['ipcRenderer'].invoke('select-folder-saveAs', options);
      },
      
      // === 服务访问 ===
      translate: async (key: string) => {
        return this.provider?.translateService?.instant(key) || key;
      },
      
      showMessage: (type: 'success' | 'error' | 'warning' | 'info', content: string) => {
        this.provider?.messageService?.[type](content);
      },
      
      closeTool: (toolId: string) => {
        this.provider?.uiService?.closeTool(toolId);
      },
      
      openInNewWindow: (route: string) => {
        window['ipcRenderer'].send('open-window', { route });
      },
      
      // === 项目/配置 ===
      getCurrentProjectPath: async () => {
        return this.provider?.projectService?.currentProjectPath || null;
      },
      
      getCurrentBoard: async () => {
        return this.provider?.projectService?.currentPackageData?.board || null;
      },
      
      getConfig: async (key: string) => {
        return this.provider?.configService?.data?.[key];
      },
      
      saveConfig: async (key: string, value: any) => {
        if (this.provider?.configService) {
          this.provider.configService.data[key] = value;
          this.provider.configService.save();
        }
      },
      
      getCurrentPort: async () => {
        return this.provider?.serialService?.currentPort || null;
      }
    };
    
    // 合并子应用自定义方法
    const customMethods = this.customMethods.get(appId) || {};
    
    return { ...commonMethods, ...customMethods };
  }
  
  /**
   * 检查连接是否就绪
   */
  isConnectionReady(appId = 'default'): boolean {
    return this.connectionReady.get(appId)?.value || false;
  }
  
  /**
   * 销毁连接
   */
  destroy(appId?: string): void {
    if (appId) {
      const connection = this.connections.get(appId);
      if (connection) {
        connection.destroy();
        this.connections.delete(appId);
        this.childMethodsMap.delete(appId);
        this.connectionReady.get(appId)?.next(false);
      }
    } else {
      // 销毁所有连接
      this.connections.forEach((conn) => conn.destroy());
      this.connections.clear();
      this.childMethodsMap.clear();
      this.connectionReady.forEach((ready) => ready.next(false));
    }
  }
  
  /**
   * 调用子应用方法
   */
  async callChild<T = void>(appId: string, method: string, ...args: any[]): Promise<T | undefined> {
    const childMethods = this.childMethodsMap.get(appId);
    if (!childMethods) return undefined;
    
    try {
      const fn = (childMethods as any)[method];
      if (typeof fn === 'function') {
        return fn(...args);
      }
    } catch (error) {
      console.error(`[SubappBridge] Failed to call ${method} on ${appId}:`, error);
    }
    return undefined;
  }
  
  /**
   * 设置端口（便捷方法）
   */
  setPort(appId: string, port: string): void {
    this.callChild(appId, 'setPort', port);
  }
  
  /**
   * 强制断开（便捷方法）
   */
  forceDisconnect(appId: string): void {
    this.callChild(appId, 'forceDisconnect');
  }
}


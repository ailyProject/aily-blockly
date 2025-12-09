// 扩展 Window 接口以包含 electronAPI
declare global {
  interface Window {
    electronAPI: {
      SerialPort: {
        // 列出可用串口
        list: () => Promise<any[]>;
        // 旧版 API (兼容)
        create: (options: any) => any;
        // 新版 API (iframe 通信用)
        connect?: (options: any) => Promise<any>;
        disconnect?: () => Promise<any>;
        send?: (data: any) => Promise<any>;
        getStatus?: () => Promise<any>;
        // 事件监听
        onData?: (callback: (data: any) => void) => () => void;
        onError?: (callback: (error: any) => void) => () => void;
        onDisconnected?: (callback: () => void) => () => void;
      };
      safeStorage: {
        isEncryptionAvailable: () => boolean;
        encryptString: (plainText: string) => Buffer;
        decryptString: (encrypted: Buffer) => string;
      };
      ipcRenderer: any;
      path: any;
      platform: any;
      terminal: any;
      iWindow: any;
      subWindow: any;
      builder: any;
      uploader: any;
      fs: any;
      ble: any;
      wifi: any;
      dialog: any;
      other: any;
      env: any;
      npm: any;
      cmd: any;
      updater: any;
      mcp: any;
      versions: () => any;
    };
  }
}

export {};

// 扩展 Window 接口以包含 electronAPI
declare global {
  interface Window {
    electronAPI: {
      SerialPort: {
        list: () => Promise<any[]>;
        create: (options: any) => any;
        createRaw: (options: any) => any;
      };
      safeStorage: {
        isEncryptionAvailable: () => boolean;
        encryptString: (plainText: string) => Buffer;
        decryptString: (encrypted: Buffer) => string;
      };
      ipcRenderer: any;
      path: any;
      platform: any;
      /** 系统文件管理器高亮（如访达、资源管理器） */
      shell?: {
        showItemInFolder: (fullPath: string) => void;
      };
      terminal: any;
      iWindow: any;
      subWindow: any;
      coderEmbed: {
        getBaseUrl: () => Promise<string>;
      };
      codeViewer: any;
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
      probeRs: any;
      updater: any;
      mcp: any;
      versions: () => any;
    };
  }
}

export {};

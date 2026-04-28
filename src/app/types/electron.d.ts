// 扩展 Window 接口以包含 electronAPI
declare global {
  interface Window {
    electronAPI: {
      SerialPort: {
        list: () => Promise<any[]>;
        create: (options: any) => any;
      };
      safeStorage: {
        isEncryptionAvailable: () => boolean;
        encryptString: (plainText: string) => Buffer;
        decryptString: (encrypted: Buffer) => string;
      };
      file: {
        getPath: (file: File) => string | null;
        startDrag: (filePaths: string | string[]) => Promise<{ success: boolean; error?: string }>;
      };
      ipcRenderer: any;
      path: any;
      platform: any;
      terminal: any;
      iWindow: any;
      subWindow: any;
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

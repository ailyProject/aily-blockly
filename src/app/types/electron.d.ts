// 扩展 Window 接口以包含 electronAPI
declare global {
  interface Window {
    openAndSendToAilyChat: (text: string, options?: Record<string, any>) => void;
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
      clipboard?: {
        writeText: (text: string) => void;
        readText: () => string;
      };
      terminal: any;
      ailyServicesStream?: {
        start: (data: any) => Promise<{ ok?: boolean; streamId?: string; error?: string }>;
        cancel: (streamId: string) => Promise<any>;
        onEvent: (streamId: string, callback: (payload: any) => void) => () => void;
      };
      chatRuntimeHost?: {
        registerRuntimeOwner: (runtimeOwnerId: string) => Promise<{ ok?: boolean; runtimeOwnerId?: string }>;
        unregisterRuntimeOwner: (runtimeOwnerId: string) => Promise<{ ok?: boolean }>;
        registerResourceOperationHandler: (handlerId: string) => Promise<{ ok?: boolean; handlerId?: string }>;
        unregisterResourceOperationHandler: (handlerId: string) => Promise<{ ok?: boolean }>;
        call: (method: string, args: readonly unknown[]) => Promise<unknown>;
        onRuntimeOwnerCommand: (callback: (payload: unknown) => void) => () => void;
        onResourceOperationCommand: (callback: (payload: unknown) => void) => () => void;
        sendRuntimeOwnerResponse: (payload: unknown) => void;
        sendResourceOperationResponse: (payload: unknown) => void;
        emitRuntimeOwnerEvent: (payload: unknown) => void;
        onEvent: (callback: (payload: any) => void) => () => void;
      };
      subapps?: {
        list: (options?: { refresh?: boolean; locale?: string }) => Promise<any>;
        install: (options: { id: string; locale?: string }) => Promise<any>;
        update: (options: { id: string; locale?: string }) => Promise<any>;
        uninstall: (options: { id: string; locale?: string }) => Promise<any>;
        onChanged: (callback: (payload: any) => void) => () => void;
      };
      webviewBridge?: {
        fetchPage: (data: any) => Promise<any>;
        searchWeb: (data: any) => Promise<any>;
      };
      iWindow: any;
      subWindow: any;
      coderEmbed: {
        getBaseUrl: () => Promise<string>;
      };
      codeViewer: any;
      builder: any;
      linter: any;
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

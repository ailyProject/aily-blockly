// Electron preload API exposed to the Angular renderer.
type AilyConnectorTransport = 'ssh' | 'serial';

interface AilyConnectorSshEndpoint {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  hostKeyPolicy?: 'trust-on-first-use' | 'strict';
}

interface AilyConnectorSerialEndpoint {
  port: string;
  baudRate?: number;
  allowRawConsole?: boolean;
}

interface AilyConnectorCredentials {
  password?: string;
  hostKey?: string;
}

interface AilyConnectorSession {
  sessionId: string;
  transport: AilyConnectorTransport;
  status: Record<string, unknown>;
  capabilities: Record<string, unknown> | null;
}

interface AilyConnectorEvent {
  sessionId?: string;
  transport?: AilyConnectorTransport;
  sequence?: number;
  event?: {
    type: string;
    text?: string;
    data?: Uint8Array;
    [key: string]: unknown;
  };
  type?: string;
  error?: { code: string; message: string };
}

interface AilyConnectorApi {
  status(): Promise<Record<string, unknown>>;
  checkForUpdate(): Promise<Record<string, unknown>>;
  update(): Promise<Record<string, unknown>>;
  waitForReady(): Promise<{ version: string; protocolVersion: number }>;
  connect(options: {
    transport: AilyConnectorTransport;
    endpoint: AilyConnectorSshEndpoint | AilyConnectorSerialEndpoint;
    credentials?: AilyConnectorCredentials;
  }): Promise<AilyConnectorSession>;
  request<T = unknown>(options: {
    sessionId: string;
    operation: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<T>;
  disconnect(options: { sessionId: string }): Promise<{ disconnected: boolean }>;
  onEvent(callback: (event: AilyConnectorEvent) => void): () => void;
}

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
      shell?: {
        showItemInFolder: (fullPath: string) => void;
      };
      clipboard?: {
        writeText: (text: string) => void;
        readText: () => string;
      };
      terminal: any;
      ailyServicesStream?: {
        start: (data: any) => Promise<{
          ok?: boolean;
          streamId?: string;
          error?: string;
        }>;
        cancel: (streamId: string) => Promise<any>;
        onEvent: (
          streamId: string,
          callback: (payload: any) => void,
        ) => () => void;
      };
      subapps?: {
        list: (options?: { refresh?: boolean; locale?: string }) => Promise<any>;
        install: (options: {
          id: string;
          locale?: string;
          forceClose?: boolean;
        }) => Promise<any>;
        update: (options: {
          id: string;
          locale?: string;
          forceClose?: boolean;
        }) => Promise<any>;
        uninstall: (options: {
          id: string;
          locale?: string;
          forceClose?: boolean;
        }) => Promise<any>;
        onChanged: (callback: (payload: any) => void) => () => void;
        onProgress: (callback: (payload: {
          id: string;
          action: string;
          phase: string;
          percent: number;
          downloadProgress?: number;
          extractProgress?: number;
          error?: string;
        }) => void) => () => void;
      };
      webviewBridge?: {
        fetchPage: (data: any) => Promise<any>;
        searchWeb: (data: any) => Promise<any>;
      };
      iWindow: any;
      subWindow: any;
      codeViewer: any;
      builder: any;
      connector?: AilyConnectorApi;
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

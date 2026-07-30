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
      coderEmbed: {
        getBaseUrl: () => Promise<string>;
      };
      codeViewer: any;
      builder: any;
      simulatorGateway?: {
        iframeUrlOverride?: string;
        start: (projectPath: string, ownerId?: string) => Promise<{
          baseUrl: string;
          accessToken: string;
          artifactDirectory: string;
          artifact: unknown;
          debugSource: {
            file: string;
            revision: string;
            sizeBytes: number;
            content: string;
          } | null;
          debugSourceMap?: unknown;
          runtimeSource: string;
          runtimePackId?: string;
          runtimeMode?: string;
        }>;
        status: () => Promise<{
          state: 'ready' | 'stopped';
          baseUrl?: string;
          projectPath?: string;
          runtimeSource?: string;
          runtimePackId?: string;
          runtimeMode?: string;
          lastFailure?: {
            phase: string;
            message: string;
            code?: number | null;
            signal?: string | null;
            stdoutTail?: string;
            stderrTail?: string;
            occurredAt: string;
          };
        }>;
        stop: (
          expectedProjectPath?: string,
          expectedOwnerId?: string,
        ) => Promise<{
          state: 'ready' | 'stopped';
          projectPath?: string;
        }>;
        onStateChanged: (
          callback: (state: {
            state: 'starting' | 'ready' | 'stopped' | 'failed';
            unexpected?: boolean;
            code?: number | null;
            signal?: string | null;
            failure?: {
              phase: string;
              message: string;
              code?: number | null;
              signal?: string | null;
              stdoutTail?: string;
              stderrTail?: string;
              occurredAt: string;
            };
          }) => void,
        ) => () => void;
      };
      simulatorSubapp?: {
        open: (options: {
          projectPath: string;
          ownerId?: string;
          tool?: 'scene' | 'debugger';
          sceneId?: string;
          connectionGraph: Record<string, unknown>;
        }) => Promise<{
          schemaVersion: 1;
          kind: 'aily-simulator-subapp-surface';
          state: 'ready';
          tool: 'scene' | 'debugger';
          url: string;
          origin: string;
          launchId: string;
          runtimeSource: string;
          runtimePackId?: string;
          runtimeMode?: string;
        }>;
        openProjectScene: (options: {
          projectPath: string;
          ownerId?: string;
          sceneId?: string;
        }) => Promise<({
          schemaVersion: 1;
          kind: 'aily-simulator-subapp-surface';
          state: 'ready';
          tool: 'scene';
          url: string;
          origin: string;
          launchId: string;
          initialization: 'existing' | 'created-empty' | 'regenerated-v2';
          runtimeSource: string;
          runtimePackId?: string;
          runtimeMode?: string;
        } | {
          schemaVersion: 1;
          kind: 'aily-simulator-subapp-project-scene-regeneration-required';
          state: 'legacy-scene-regeneration-required';
          tool: 'scene';
          initialization: 'legacy-detected';
          requirement: {
            schemaVersion: 1;
            kind: 'aily-project-scene-legacy-regeneration-required';
            regenerationId: string;
            projectIdentity: string;
            sceneId: string;
            legacySourceKind: 'connection-output-v1';
            legacySourceRevision: string;
            legacySourceBytes: number;
            catalogRevision: string;
            draftVisualRevision: string;
            draftGraphSemanticRevision: string;
            expiresAtUnixMs: number;
          };
          runtimeSource: string;
          runtimePackId?: string;
          runtimeMode?: string;
        })>;
        requestProjectSceneGeneration: (options: {
          ownerId?: string;
          regenerationId: string;
        }) => Promise<{
          schemaVersion: 1;
          kind: 'aily-simulator-subapp-project-scene-generation-request-result';
          state: 'accepted';
          regenerationId: string;
          requestId: string;
        }>;
        resolveProjectSceneRegeneration: (options: {
          ownerId?: string;
          regenerationId: string;
          resolution: 'cancel' | 'commit';
          proposal?: Record<string, unknown>;
        }) => Promise<Record<string, unknown>>;
        applyProjectSceneAgentProposal: (options: {
          ownerId?: string;
          proposal: Record<string, unknown>;
        }) => Promise<Record<string, unknown>>;
        attachProjectSceneSession: (ownerId?: string) => Promise<{
          schemaVersion: 1;
          kind: 'aily-project-scene-session-attachment-result';
          state: 'attached';
          session: {
            sessionId: string;
            state: string;
            sceneRevision: string | null;
          };
        }>;
        detachProjectSceneSession: (ownerId?: string) => Promise<{
          schemaVersion: 1;
          kind: 'aily-project-scene-session-detachment-result';
          state: 'detached';
        }>;
        status: () => Promise<{
          state: 'ready' | 'stopped' | 'legacy-scene-regeneration-required';
          tool?: 'scene' | 'debugger';
          launchId?: string;
          sessionState?: string;
          runtimeSource?: string;
          runtimePackId?: string;
          runtimeMode?: string;
          initialization?: 'existing' | 'created-empty' | 'legacy-detected'
            | 'regenerated-v2';
          requirement?: Record<string, unknown>;
          lastFailure?: {
            phase: string;
            message: string;
            code: number | null;
            signal: string | null;
            occurredAt: string;
          };
        }>;
        close: (ownerId?: string) => Promise<{
          state: 'ready' | 'stopped';
        }>;
        onStateChanged: (
          callback: (state: {
            state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
              | 'rebuild-requested' | 'artifact-rebuild-state-changed'
              | 'artifact-rebuild-candidate-ready'
              | 'legacy-scene-regeneration-required'
              | 'scene-generation-requested'
              | 'scene-generation-candidate-ready'
              | 'scene-generation-failed';
            unexpected?: boolean;
            surface?: {
              schemaVersion: 1;
              kind: 'aily-simulator-subapp-surface';
              state: 'ready';
              tool: 'scene' | 'debugger';
              url: string;
              origin: string;
              launchId: string;
              runtimeSource: string;
              runtimePackId?: string;
              runtimeMode?: string;
            };
            failure?: {
              phase?: string;
              message: string;
              code?: number | string | null;
              signal?: string | null;
              occurredAt?: string;
            };
            requirement?: Record<string, unknown>;
          }) => void,
        ) => () => void;
        onProjectRebuildRequested: (
          callback: (
            request: Record<string, unknown>,
            transport: {
              requestId: string;
              rendererGeneration: number;
            },
          ) => void,
        ) => () => void;
        respondProjectRebuild: (
          transport: {
            requestId: string;
            rendererGeneration: number;
          },
          result: Record<string, unknown>,
        ) => void;
      };
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

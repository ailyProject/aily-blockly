import type {
  ChatRuntimeHost,
  ChatRuntimeHostAttachViewOptions,
  ChatRuntimeOwnerExecutorCommandMethod,
  ChatRuntimeOwnerExecutorEvent,
  ChatRuntimeOwnerExecutor,
  ChatRuntimeHostEvent,
  ChatRuntimeHostEventSubscription,
  ChatRuntimeHostCheckpointMutationRequest,
  ChatRuntimeHostCheckpointMutationResult,
  ChatRuntimeHostCheckpointNavigationRequest,
  ChatRuntimeHostCheckpointNavigationState,
  ChatRuntimeHostForkSessionRequest,
  ChatRuntimeHostForkSessionResult,
  ChatRuntimeHostInteractionRequest,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHostPrewarmRequest,
  ChatRuntimeHostPrewarmResult,
  ChatRuntimeHostRestoreRuntimeSessionRequest,
  ChatRuntimeHostRestoreRuntimeSessionResult,
  ChatRuntimeHostRequestListMutationRequest,
  ChatRuntimeHostRequestListMutationResult,
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
  ChatRuntimeHostRerunReadiness,
  ChatRuntimeHostResourceRequest,
  ChatRuntimeHostResourceRequestEvent,
  ChatRuntimeHostSessionId,
  ChatRuntimeHostSessionExecutionState,
  ChatRuntimeHostSessionInventorySnapshot,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostStopTurnRequest,
  ChatRuntimeHostSubmitReadiness,
  ChatRuntimeHostSubmitRequest,
  ChatRuntimeHostTranscriptSnapshot,
  ChatRuntimeHostTurnPage,
  ChatRuntimeHostTurnPageRequest,
  ChatRuntimeHostViewId,
} from './chat-runtime-host-contract';
import {
  callRuntimeOwnerMethod,
  createProtocolSafePayload,
  createRuntimeOwnerEvent,
  createRuntimeOwnerRegistrationState,
  normalizeRuntimeOwnerMethod,
  trackRuntimeOwnerCommand,
} from './chat-runtime-owner-executor-bridge';
import type { RuntimeOwnerRegistrationState } from './chat-runtime-owner-executor-bridge';

type RuntimeHostMethod =
  | 'attachView'
  | 'detachView'
  | 'prewarmRuntime'
  | 'restoreRuntimeSession'
  | 'readSessionExecutionState'
  | 'submitTurn'
  | 'readSubmitReadiness'
  | 'ensureSessionCanRerun'
  | 'stopTurn'
  | 'disposeSession'
  | 'readSessionState'
  | 'readSessionInventory'
  | 'readTranscript'
  | 'readSessionTurnPage'
  | 'readCheckpointNavigationState'
  | 'mutateSessionRequestList'
  | 'restoreSessionCheckpoint'
  | 'redoSessionCheckpoint'
  | 'forkSession'
  | 'awaitRequestCompletion'
  | 'runWorkspaceFinalizeBoundaryProbe'
  | 'readInteractionSnapshot'
  | 'resolveInteraction'
  | 'recordResourceRequest'
  | 'requestResourceOperation';

interface ElectronChatRuntimeHostApi {
  call(method: RuntimeHostMethod, args: readonly unknown[]): Promise<unknown>;
  registerRuntimeOwner(runtimeOwnerId: string): Promise<{ ok?: boolean; runtimeOwnerId?: string }>;
  unregisterRuntimeOwner(runtimeOwnerId: string): Promise<{ ok?: boolean }>;
  registerResourceOperationHandler(handlerId: string): Promise<{ ok?: boolean; handlerId?: string }>;
  unregisterResourceOperationHandler(handlerId: string): Promise<{ ok?: boolean }>;
  onRuntimeOwnerCommand(callback: (payload: ElectronRuntimeOwnerCommandPayload) => void): () => void;
  onResourceOperationCommand(callback: (payload: ElectronResourceOperationCommandPayload) => void): () => void;
  sendRuntimeOwnerResponse(payload: ElectronRuntimeOwnerCommandResponse): void;
  sendResourceOperationResponse(payload: ElectronResourceOperationCommandResponse): void;
  emitRuntimeOwnerEvent(payload: ChatRuntimeOwnerExecutorEvent): void;
  onEvent(callback: (event: ChatRuntimeHostEvent) => void): () => void;
}

interface ElectronRuntimeOwnerCommandPayload {
  readonly requestId?: string;
  readonly method?: string;
  readonly args?: readonly unknown[];
}

interface ElectronRuntimeOwnerCommandResponse {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
}

interface ElectronResourceOperationCommandPayload {
  readonly requestId?: string;
  readonly request?: ChatRuntimeHostResourceOperationRequest;
}

interface ElectronResourceOperationCommandResponse {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
    readonly retryable?: boolean;
  };
}

export interface ElectronChatRuntimeOwnerRegistration {
  dispose(): Promise<void>;
}

export interface ElectronChatRuntimeResourceOperationHandlerRegistration {
  dispose(): Promise<void>;
}

export type ElectronChatRuntimeResourceOperationHandler = (
  request: ChatRuntimeHostResourceOperationRequest,
) => Promise<unknown> | unknown;

function readElectronChatRuntimeHostApi(): ElectronChatRuntimeHostApi | null {
  const api = (globalThis as unknown as { electronAPI?: { chatRuntimeHost?: Partial<ElectronChatRuntimeHostApi> } })
    .electronAPI?.chatRuntimeHost;
  if (!api
    || typeof api.call !== 'function'
    || typeof api.registerRuntimeOwner !== 'function'
    || typeof api.unregisterRuntimeOwner !== 'function'
    || typeof api.registerResourceOperationHandler !== 'function'
    || typeof api.unregisterResourceOperationHandler !== 'function'
    || typeof api.onRuntimeOwnerCommand !== 'function'
    || typeof api.onResourceOperationCommand !== 'function'
    || typeof api.sendRuntimeOwnerResponse !== 'function'
    || typeof api.sendResourceOperationResponse !== 'function'
    || typeof api.emitRuntimeOwnerEvent !== 'function'
    || typeof api.onEvent !== 'function') {
    return null;
  }
  return api as ElectronChatRuntimeHostApi;
}

export async function registerElectronChatRuntimeResourceOperationHandler(
  handler: ElectronChatRuntimeResourceOperationHandler,
  handlerId = 'aily-chat-host-resource-handler',
): Promise<ElectronChatRuntimeResourceOperationHandlerRegistration> {
  const api = readElectronChatRuntimeHostApi();
  if (!api) {
    throw new Error('[AilyChat][RuntimeHost] Electron runtime host API is unavailable.');
  }
  if (typeof handler !== 'function') {
    throw new Error('[AilyChat][RuntimeHost] Runtime resource operation handler is required.');
  }

  const registration = await api.registerResourceOperationHandler(handlerId);
  if (!registration?.ok) {
    throw new Error('[AilyChat][RuntimeHost] Failed to register Electron runtime resource operation handler.');
  }

  const unsubscribeCommands = api.onResourceOperationCommand(payload => {
    void dispatchResourceOperationCommand(handler, api, payload);
  });

  let disposed = false;
  return {
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeCommands();
      await api.unregisterResourceOperationHandler(handlerId);
    },
  };
}

async function dispatchResourceOperationCommand(
  handler: ElectronChatRuntimeResourceOperationHandler,
  api: ElectronChatRuntimeHostApi,
  payload: ElectronResourceOperationCommandPayload,
): Promise<void> {
  let requestId = '';
  try {
    requestId = normalizeRequestId(payload.requestId);
    const request = payload.request;
    if (!request || typeof request !== 'object') {
      throw new Error('[AilyChat][RuntimeHost] Runtime resource operation command requires a request.');
    }
    const result = await handler(request);
    api.sendResourceOperationResponse(createProtocolSafePayload({ requestId, ok: true, result }));
  } catch (error) {
    if (!requestId && typeof payload.requestId === 'string') {
      requestId = payload.requestId;
    }
    if (!requestId) {
      return;
    }
    const errorPayload = createErrorPayload(error) as { message: string; code?: string; retryable?: boolean };
    const maybeError = error as { retryable?: unknown } | null | undefined;
    if (typeof maybeError?.retryable === 'boolean') {
      errorPayload.retryable = maybeError.retryable;
    }
    api.sendResourceOperationResponse(createProtocolSafePayload({
      requestId,
      ok: false,
      error: errorPayload,
    }));
  }
}

function createErrorPayload(error: unknown): { message: string; code?: string } {
  const maybeError = error as { message?: unknown; code?: unknown } | null | undefined;
  return {
    message: typeof maybeError?.message === 'string' ? maybeError.message : String(error || 'Unknown runtime host error'),
    code: typeof maybeError?.code === 'string' ? maybeError.code : undefined,
  };
}

function normalizeRequestId(requestId: unknown): string {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalized) {
    throw new Error('[AilyChat][RuntimeHost] Missing runtime owner command request id.');
  }
  return normalized;
}

export function createElectronChatRuntimeHostTransport(): ChatRuntimeHost | null {
  const api = readElectronChatRuntimeHostApi();
  if (!api) {
    return null;
  }

  return {
    attachView: (
      viewId: ChatRuntimeHostViewId,
      sessionId: ChatRuntimeHostSessionId,
      options?: ChatRuntimeHostAttachViewOptions,
    ) =>
      api.call('attachView', [viewId, sessionId, options]) as Promise<ChatRuntimeHostSessionState>,
    detachView: (viewId: ChatRuntimeHostViewId) =>
      api.call('detachView', [viewId]) as Promise<void>,
    prewarmRuntime: (request: ChatRuntimeHostPrewarmRequest) =>
      api.call('prewarmRuntime', [request]) as Promise<ChatRuntimeHostPrewarmResult>,
    restoreRuntimeSession: (request: ChatRuntimeHostRestoreRuntimeSessionRequest) =>
      api.call('restoreRuntimeSession', [request]) as Promise<ChatRuntimeHostRestoreRuntimeSessionResult>,
    readSessionExecutionState: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readSessionExecutionState', [sessionId]) as Promise<ChatRuntimeHostSessionExecutionState>,
    submitTurn: (request: ChatRuntimeHostSubmitRequest) =>
      api.call('submitTurn', [request]) as Promise<ChatRuntimeHostSessionState>,
    readSubmitReadiness: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readSubmitReadiness', [sessionId]) as Promise<ChatRuntimeHostSubmitReadiness>,
    ensureSessionCanRerun: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('ensureSessionCanRerun', [sessionId]) as Promise<ChatRuntimeHostRerunReadiness>,
    stopTurn: (request: ChatRuntimeHostSessionId | ChatRuntimeHostStopTurnRequest) =>
      api.call('stopTurn', [request]) as Promise<void>,
    disposeSession: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('disposeSession', [sessionId]) as Promise<void>,
    readSessionState: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readSessionState', [sessionId]) as Promise<ChatRuntimeHostSessionState | null>,
    readSessionInventory: () =>
      api.call('readSessionInventory', []) as Promise<ChatRuntimeHostSessionInventorySnapshot>,
    readTranscript: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readTranscript', [sessionId]) as Promise<ChatRuntimeHostTranscriptSnapshot | null>,
    readSessionTurnPage: (request: ChatRuntimeHostTurnPageRequest) =>
      api.call('readSessionTurnPage', [request]) as Promise<ChatRuntimeHostTurnPage | null>,
    readCheckpointNavigationState: (request: ChatRuntimeHostCheckpointNavigationRequest) =>
      api.call('readCheckpointNavigationState', [request]) as Promise<ChatRuntimeHostCheckpointNavigationState | null>,
    mutateSessionRequestList: (request: ChatRuntimeHostRequestListMutationRequest) =>
      api.call('mutateSessionRequestList', [request]) as Promise<ChatRuntimeHostRequestListMutationResult>,
    restoreSessionCheckpoint: (request: ChatRuntimeHostCheckpointMutationRequest & { readonly checkpointId: string }) =>
      api.call('restoreSessionCheckpoint', [request]) as Promise<ChatRuntimeHostCheckpointMutationResult>,
    redoSessionCheckpoint: (request: ChatRuntimeHostCheckpointMutationRequest) =>
      api.call('redoSessionCheckpoint', [request]) as Promise<ChatRuntimeHostCheckpointMutationResult>,
    forkSession: (request: ChatRuntimeHostForkSessionRequest) =>
      api.call('forkSession', [request]) as Promise<ChatRuntimeHostForkSessionResult>,
    awaitRequestCompletion: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('awaitRequestCompletion', [sessionId]) as Promise<void>,
    runWorkspaceFinalizeBoundaryProbe: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('runWorkspaceFinalizeBoundaryProbe', [sessionId]) as Promise<void>,
    readInteractionSnapshot: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readInteractionSnapshot', [sessionId]) as Promise<ChatRuntimeHostInteractionSnapshot | null>,
    resolveInteraction: (request: ChatRuntimeHostInteractionRequest) =>
      api.call('resolveInteraction', [request]) as Promise<ChatRuntimeHostInteractionSnapshot | null>,
    recordResourceRequest: (request: ChatRuntimeHostResourceRequest) =>
      api.call('recordResourceRequest', [request]) as Promise<ChatRuntimeHostResourceRequestEvent | null>,
    requestResourceOperation: (request: ChatRuntimeHostResourceOperationRequest) =>
      api.call('requestResourceOperation', [request]) as Promise<ChatRuntimeHostResourceOperationResult>,
    onEvent: (listener: (event: ChatRuntimeHostEvent) => void): ChatRuntimeHostEventSubscription => {
      const unsubscribe = api.onEvent(listener);
      return { dispose: unsubscribe };
    },
  };
}

export async function registerElectronChatRuntimeOwner(
  runtimeOwner: ChatRuntimeOwnerExecutor,
  runtimeOwnerId = 'aily-chat-host-runtime-owner',
): Promise<ElectronChatRuntimeOwnerRegistration> {
  const api = readElectronChatRuntimeHostApi();
  if (!api) {
    throw new Error('[AilyChat][RuntimeHost] Electron runtime host API is unavailable.');
  }

  const registration = await api.registerRuntimeOwner(runtimeOwnerId);
  if (!registration?.ok) {
    throw new Error('[AilyChat][RuntimeHost] Failed to register Electron runtime owner.');
  }

  const registrationState = createRuntimeOwnerRegistrationState();
  const runtimeOwnerEvents = runtimeOwner.onEvent(event => {
    const ownerEvent = createRuntimeOwnerEvent(event, registrationState);
    if (ownerEvent) {
      api.emitRuntimeOwnerEvent(createProtocolSafePayload(ownerEvent));
    }
  });
  const unsubscribeCommands = api.onRuntimeOwnerCommand(payload => {
    void dispatchRuntimeOwnerCommand(runtimeOwner, api, payload, registrationState);
  });

  let disposed = false;
  return {
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeCommands();
      runtimeOwnerEvents.dispose();
      await api.unregisterRuntimeOwner(runtimeOwnerId);
    },
  };
}

async function dispatchRuntimeOwnerCommand(
  runtimeOwner: ChatRuntimeOwnerExecutor,
  api: ElectronChatRuntimeHostApi,
  payload: ElectronRuntimeOwnerCommandPayload,
  registrationState: RuntimeOwnerRegistrationState,
): Promise<void> {
  let requestId = '';
  let method: ChatRuntimeOwnerExecutorCommandMethod | '' = '';
  try {
    requestId = normalizeRequestId(payload.requestId);
    method = normalizeRuntimeOwnerMethod(payload.method);
    const args = Array.isArray(payload.args) ? payload.args : [];
    trackRuntimeOwnerCommand(method, args, registrationState);
    const result = await callRuntimeOwnerMethod(runtimeOwner, method, args);
    api.sendRuntimeOwnerResponse(createProtocolSafePayload({ requestId, ok: true, result }));
  } catch (error) {
    console.error('[AilyChat][RuntimeHost] Runtime owner command failed:', {
      requestId,
      method: method || payload.method,
      error: createErrorPayload(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!requestId && typeof payload.requestId === 'string') {
      requestId = payload.requestId;
    }
    if (!requestId) {
      return;
    }
    api.sendRuntimeOwnerResponse(createProtocolSafePayload({
      requestId,
      ok: false,
      error: createErrorPayload(error),
    }));
  }
}

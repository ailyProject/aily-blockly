import type {
  ChatRuntimeHost,
  ChatRuntimeHostAttachViewOptions,
  ChatRuntimeOwnerExecutorCommandMethod,
  ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand,
  ChatRuntimeOwnerExecutorEvent,
  ChatRuntimeOwnerExecutor,
  ChatRuntimeOwnerExecutorRenderEventProgress,
  ChatRuntimeHostEvent,
  ChatRuntimeHostEventSubscription,
  ChatRuntimeOwnerExecutorResolveInteractionCommand,
  ChatRuntimeOwnerExecutorStartTurnCommand,
  ChatRuntimeOwnerExecutorStopTurnCommand,
  ChatRuntimeHostInteractionRequest,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
  ChatRuntimeHostRerunReadiness,
  ChatRuntimeHostResourceRequest,
  ChatRuntimeHostResourceRequestEvent,
  ChatRuntimeHostSessionId,
  ChatRuntimeHostSessionInventorySnapshot,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostSubmitReadiness,
  ChatRuntimeHostSubmitRequest,
  ChatRuntimeHostTranscriptSnapshot,
  ChatRuntimeHostViewId,
} from './chat-runtime-host-contract';

type RuntimeHostMethod =
  | 'attachView'
  | 'detachView'
  | 'submitTurn'
  | 'readSubmitReadiness'
  | 'ensureSessionCanRerun'
  | 'stopTurn'
  | 'disposeSession'
  | 'readSessionState'
  | 'readSessionInventory'
  | 'readTranscript'
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

interface RuntimeOwnerRegistrationState {
  readonly activeTurnIds: Map<ChatRuntimeHostSessionId, string>;
  readonly activeRequestIds: Map<ChatRuntimeHostSessionId, string>;
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
    api.sendResourceOperationResponse(createIpcSafePayload({ requestId, ok: true, result }));
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
    api.sendResourceOperationResponse(createIpcSafePayload({
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

function normalizeRuntimeOwnerMethod(method: unknown): ChatRuntimeOwnerExecutorCommandMethod {
  switch (method) {
    case 'startTurn':
    case 'stopTurn':
    case 'disposeSessionResources':
    case 'resolveInteraction':
      return method;
    default:
      throw new Error(`[AilyChat][RuntimeHost] Unsupported runtime owner command method: ${String(method || '<missing>')}`);
  }
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
    submitTurn: (request: ChatRuntimeHostSubmitRequest) =>
      api.call('submitTurn', [request]) as Promise<ChatRuntimeHostSessionState>,
    readSubmitReadiness: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readSubmitReadiness', [sessionId]) as Promise<ChatRuntimeHostSubmitReadiness>,
    ensureSessionCanRerun: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('ensureSessionCanRerun', [sessionId]) as Promise<ChatRuntimeHostRerunReadiness>,
    stopTurn: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('stopTurn', [sessionId]) as Promise<void>,
    disposeSession: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('disposeSession', [sessionId]) as Promise<void>,
    readSessionState: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readSessionState', [sessionId]) as Promise<ChatRuntimeHostSessionState | null>,
    readSessionInventory: () =>
      api.call('readSessionInventory', []) as Promise<ChatRuntimeHostSessionInventorySnapshot>,
    readTranscript: (sessionId: ChatRuntimeHostSessionId) =>
      api.call('readTranscript', [sessionId]) as Promise<ChatRuntimeHostTranscriptSnapshot | null>,
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

  const registrationState: RuntimeOwnerRegistrationState = {
    activeTurnIds: new Map(),
    activeRequestIds: new Map(),
  };
  const runtimeOwnerEvents = runtimeOwner.onEvent(event => {
    const ownerEvent = createRuntimeOwnerEvent(event, registrationState);
    if (ownerEvent) {
      api.emitRuntimeOwnerEvent(createIpcSafePayload(ownerEvent));
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
    api.sendRuntimeOwnerResponse(createIpcSafePayload({ requestId, ok: true, result }));
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
    api.sendRuntimeOwnerResponse(createIpcSafePayload({
      requestId,
      ok: false,
      error: createErrorPayload(error),
    }));
  }
}

function trackRuntimeOwnerCommand(
  method: ChatRuntimeOwnerExecutorCommandMethod,
  args: readonly unknown[],
  registrationState: RuntimeOwnerRegistrationState,
): void {
  switch (method) {
    case 'startTurn': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorStartTurnCommand> | null | undefined;
      const sessionId = normalizeNonEmptyString(command?.sessionId ?? command?.request?.sessionId);
      const turnId = normalizeNonEmptyString(command?.turnId ?? command?.request?.activeResponseHandle);
      const requestId = readRequestMetadataRequestId(command?.request);
      if (sessionId && turnId) {
        registrationState.activeTurnIds.set(sessionId, turnId);
        if (requestId) {
          registrationState.activeRequestIds.set(sessionId, requestId);
        } else {
          registrationState.activeRequestIds.delete(sessionId);
        }
      }
      return;
    }
    case 'disposeSessionResources': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand> | null | undefined;
      const sessionId = normalizeNonEmptyString(command?.sessionId);
      if (sessionId) {
        registrationState.activeTurnIds.delete(sessionId);
        registrationState.activeRequestIds.delete(sessionId);
      }
      return;
    }
    default:
      return;
  }
}

function createRuntimeOwnerEvent(
  event: ChatRuntimeHostEvent | ChatRuntimeOwnerExecutorRenderEventProgress | ChatRuntimeOwnerExecutorEvent,
  registrationState: RuntimeOwnerRegistrationState,
): ChatRuntimeOwnerExecutorEvent | null {
  const sessionId = normalizeNonEmptyString(event.sessionId);
  if (!sessionId) {
    return null;
  }
  if (isRuntimeOwnerEvent(event)) {
    return normalizeExplicitRuntimeOwnerEvent(event, sessionId, registrationState);
  }
  const trackedTurnId = registrationState.activeTurnIds.get(sessionId) || '';
  if (event.kind === 'render-event') {
    const renderEventTurnId = readRenderEventTurnId(event.renderEvent);
    const turnId = renderEventTurnId || normalizeNonEmptyString(event.turnId) || trackedTurnId;
    if (!turnId) {
      return null;
    }
    if (renderEventTurnId) {
      registrationState.activeTurnIds.set(sessionId, renderEventTurnId);
    }
    return {
      kind: 'turnProgress',
      sessionId,
      turnId,
      revision: Number(event.revision) || 0,
      ...(event.request ? { request: event.request } : {}),
      renderEvent: event.renderEvent,
    };
  }
  const turnId = trackedTurnId || readEventTurnId(event);
  if (!turnId) {
    return null;
  }
  const revision = Number(event.revision) || 0;
  switch (event.kind) {
    case 'transcript':
    case 'turn-transcript':
      return null;
    case 'view-request':
      return {
        kind: 'turnProgress',
        sessionId,
        turnId,
        revision,
        event,
      };
    case 'resource-request':
      return {
        kind: 'turnProgress',
        sessionId,
        turnId,
        revision,
        event,
      };
    case 'session-state':
    case 'runtime-status': {
      if (event.state.requestInProgress === false) {
        registrationState.activeTurnIds.delete(sessionId);
        registrationState.activeRequestIds.delete(sessionId);
        return {
          kind: 'turnCompleted',
          sessionId,
          turnId,
          revision,
          state: event.state,
        };
      }
      if (turnId) {
        registrationState.activeTurnIds.set(sessionId, turnId);
      }
      return {
        kind: 'turnProgress',
        sessionId,
        turnId,
        revision,
        event,
      };
    }
    case 'interaction':
      return {
        kind: 'turnInteractionRequested',
        sessionId,
        turnId,
        revision,
        interaction: event.interaction,
      };
    case 'error':
      registrationState.activeTurnIds.delete(sessionId);
      registrationState.activeRequestIds.delete(sessionId);
      return {
        kind: 'turnError',
        sessionId,
        turnId,
        revision,
        error: event.error,
      };
  }
}

function isRuntimeOwnerEvent(event: unknown): event is ChatRuntimeOwnerExecutorEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const kind = (event as { readonly kind?: unknown }).kind;
  return kind === 'turnProgress'
    || kind === 'turnInteractionRequested'
    || kind === 'turnError'
    || kind === 'turnCompleted';
}

function normalizeExplicitRuntimeOwnerEvent(
  event: ChatRuntimeOwnerExecutorEvent,
  sessionId: string,
  registrationState: RuntimeOwnerRegistrationState,
): ChatRuntimeOwnerExecutorEvent | null {
  const trackedTurnId = registrationState.activeTurnIds.get(sessionId) || '';
  const turnId = normalizeNonEmptyString((event as { readonly turn?: { readonly turnId?: unknown } }).turn?.turnId)
    || normalizeNonEmptyString(event.turnId)
    || trackedTurnId;
  if (!turnId) {
    return null;
  }
  if (event.kind === 'turnCompleted' || event.kind === 'turnError') {
    registrationState.activeTurnIds.delete(sessionId);
    registrationState.activeRequestIds.delete(sessionId);
  } else {
    registrationState.activeTurnIds.set(sessionId, turnId);
  }
  return {
    ...event,
    sessionId,
    turnId,
  } as ChatRuntimeOwnerExecutorEvent;
}

function readEventTurnId(event: ChatRuntimeHostEvent): string {
  if ((event.kind === 'session-state' || event.kind === 'runtime-status') && event.state.activeTurnId) {
    return normalizeNonEmptyString(event.state.activeTurnId);
  }
  return '';
}

function readRenderEventTurnId(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }
  return normalizeNonEmptyString((event as { readonly turnId?: unknown }).turnId);
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';
}

function readRequestMetadataRequestId(request: Partial<ChatRuntimeOwnerExecutorStartTurnCommand['request']> | null | undefined): string {
  const metadata = request?.metadata;
  return metadata && typeof metadata === 'object'
    ? normalizeNonEmptyString((metadata as { requestId?: unknown }).requestId)
    : '';
}

function callRuntimeOwnerMethod(
  runtimeOwner: ChatRuntimeOwnerExecutor,
  method: ChatRuntimeOwnerExecutorCommandMethod,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case 'startTurn': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorStartTurnCommand> | null | undefined;
      const request = command?.request;
      if (!request || typeof request !== 'object') {
        throw new Error('[AilyChat][RuntimeHost] startTurn requires a submit request.');
      }
      return runtimeOwner.startTurn({
        sessionId: command?.sessionId || request.sessionId,
        turnId: command?.turnId || request.activeResponseHandle,
        request: {
          ...request,
          sessionId: command?.sessionId || request.sessionId,
          activeResponseHandle: command?.turnId || request.activeResponseHandle,
        },
        executionContext: command?.executionContext,
      } as ChatRuntimeOwnerExecutorStartTurnCommand);
    }
    case 'stopTurn': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorStopTurnCommand> | null | undefined;
      return runtimeOwner.stopTurn({
        sessionId: command?.sessionId as ChatRuntimeHostSessionId,
        turnId: command?.turnId,
      });
    }
    case 'disposeSessionResources': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand> | null | undefined;
      return runtimeOwner.disposeSessionResources({
        sessionId: command?.sessionId as ChatRuntimeHostSessionId,
      });
    }
    case 'resolveInteraction':
      return runtimeOwner.resolveInteraction(
        args[0] as ChatRuntimeOwnerExecutorResolveInteractionCommand,
      );
  }
}

function createIpcSafePayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload, createIpcSafeJsonReplacer())) as T;
}

function createIpcSafeJsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      return undefined;
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (value instanceof Map) {
      return Array.from(value.entries());
    }
    if (value instanceof Set) {
      return Array.from(value.values());
    }
    return value;
  };
}

import type {
  ChatRuntimeHostEvent,
  ChatRuntimeHostSessionId,
  ChatRuntimeOwnerExecutor,
  ChatRuntimeOwnerExecutorCommandMethod,
  ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand,
  ChatRuntimeOwnerExecutorForkSessionCommand,
  ChatRuntimeOwnerExecutorEvent,
  ChatRuntimeOwnerExecutorPrewarmRuntimeCommand,
  ChatRuntimeOwnerExecutorRenderEventProgress,
  ChatRuntimeOwnerExecutorResolveInteractionCommand,
  ChatRuntimeOwnerExecutorStartTurnCommand,
  ChatRuntimeOwnerExecutorStopTurnCommand,
} from './chat-runtime-host-contract';

export interface RuntimeOwnerRegistrationState {
  readonly activeTurnIds: Map<ChatRuntimeHostSessionId, string>;
  readonly activeRequestIds: Map<ChatRuntimeHostSessionId, string>;
}

export function createRuntimeOwnerRegistrationState(): RuntimeOwnerRegistrationState {
  return {
    activeTurnIds: new Map(),
    activeRequestIds: new Map(),
  };
}

export function normalizeRuntimeOwnerMethod(method: unknown): ChatRuntimeOwnerExecutorCommandMethod {
  switch (method) {
    case 'startTurn':
    case 'prewarmRuntime':
    case 'forkSession':
    case 'stopTurn':
    case 'disposeSessionResources':
    case 'resolveInteraction':
      return method;
    default:
      throw new Error(`[AilyChat][RuntimeHost] Unsupported runtime owner command method: ${String(method || '<missing>')}`);
  }
}

export function trackRuntimeOwnerCommand(
  method: ChatRuntimeOwnerExecutorCommandMethod,
  args: readonly unknown[],
  registrationState: RuntimeOwnerRegistrationState,
): void {
  switch (method) {
    case 'prewarmRuntime':
      return;
    case 'forkSession':
      return;
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

export function createRuntimeOwnerEvent(
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
    case 'part-transcript':
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

export function callRuntimeOwnerMethod(
  runtimeOwner: ChatRuntimeOwnerExecutor,
  method: ChatRuntimeOwnerExecutorCommandMethod,
  args: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case 'prewarmRuntime': {
      const command = args[0] as Partial<ChatRuntimeOwnerExecutorPrewarmRuntimeCommand> | null | undefined;
      return runtimeOwner.prewarmRuntime({
        sessionId: command?.sessionId as ChatRuntimeHostSessionId,
        providerOptions: command?.providerOptions ?? null,
        agentRuntimeMode: command?.agentRuntimeMode ?? null,
        currentModel: command?.currentModel ?? null,
      });
    }
    case 'forkSession': {
      const command = args[0] as ChatRuntimeOwnerExecutorForkSessionCommand;
      if (typeof runtimeOwner.forkSession !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not support session fork.');
      }
      return runtimeOwner.forkSession(command);
    }
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

export function createProtocolSafePayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload, createProtocolSafeJsonReplacer())) as T;
}

function createProtocolSafeJsonReplacer(): (key: string, value: unknown) => unknown {
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

function isRuntimeOwnerEvent(event: unknown): event is ChatRuntimeOwnerExecutorEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const kind = (event as { readonly kind?: unknown }).kind;
  return kind === 'turnProgress'
    || kind === 'runtimeProjectPathUpdated'
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

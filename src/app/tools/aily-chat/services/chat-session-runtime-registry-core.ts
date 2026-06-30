export interface ChatSessionRuntimeCapabilities {
  readonly canRunConcurrently: boolean;
  readonly canContinueInPlace: boolean;
  readonly supportsBackgroundPersistence: boolean;
}

export const DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES: ChatSessionRuntimeCapabilities = {
  canRunConcurrently: true,
  canContinueInPlace: false,
  supportsBackgroundPersistence: true,
};

export interface ChatSessionRuntimeHandle {
  readonly sessionId: string;
  readonly capabilities: ChatSessionRuntimeCapabilities;
  readonly concurrencyScope?: string;
  readonly requestInProgress: boolean;
  readonly supportsInterruption: boolean;
  readonly activeResponseHandle?: unknown;
  readonly abortController?: AbortController;
  readonly stopSession?: () => void;
  readonly disposeSession?: () => void;
}

export interface ChatSessionRuntimeHandlePatch {
  readonly capabilities?: Partial<ChatSessionRuntimeCapabilities> | null;
  readonly concurrencyScope?: string | null;
  readonly requestInProgress?: boolean;
  readonly supportsInterruption?: boolean;
  readonly activeResponseHandle?: unknown | null;
  readonly abortController?: AbortController | null;
  readonly stopSession?: (() => void) | null;
  readonly disposeSession?: (() => void) | null;
}

export interface ChatSessionActiveRequestHandle extends ChatSessionRuntimeHandlePatch {
  readonly requestInProgress: true;
  readonly supportsInterruption: true;
  readonly activeResponseHandle: unknown;
  readonly stopSession: () => void;
}

export class ChatSessionRuntimeRegistryCore {
  private readonly handles = new Map<string, ChatSessionRuntimeHandle>();

  readHandle(sessionId: string | null | undefined): ChatSessionRuntimeHandle | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId ? this.handles.get(normalizedSessionId) : undefined;
  }

  getSessionIds(): readonly string[] {
    return [...this.handles.keys()];
  }

  canStartRequest(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const handle = this.readHandle(normalizedSessionId);
    if (!handle?.requestInProgress) {
      return !normalizedSessionId || !this.hasBlockingConcurrentHandle(normalizedSessionId, handle);
    }

    return handle.capabilities.canContinueInPlace;
  }

  upsertHandle(
    sessionId: string,
    patch: ChatSessionRuntimeHandlePatch,
  ): ChatSessionRuntimeHandle {
    const previous = this.handles.get(sessionId);
    const capabilities = this.resolveCapabilities(patch.capabilities, previous);
    const concurrencyScope = patch.concurrencyScope !== undefined
      ? patch.concurrencyScope ?? undefined
      : previous?.concurrencyScope;
    const requestInProgress = typeof patch.requestInProgress === 'boolean'
      ? patch.requestInProgress
      : previous?.requestInProgress ?? false;
    const supportsInterruption = typeof patch.supportsInterruption === 'boolean'
      ? patch.supportsInterruption
      : requestInProgress
        ? previous?.supportsInterruption ?? false
        : false;
    const activeResponseHandle = patch.activeResponseHandle !== undefined
      ? patch.activeResponseHandle ?? undefined
      : requestInProgress
        ? previous?.activeResponseHandle
        : undefined;
    const abortController = patch.abortController !== undefined
      ? patch.abortController ?? undefined
      : requestInProgress
        ? previous?.abortController
        : undefined;
    const next: ChatSessionRuntimeHandle = {
      sessionId,
      capabilities,
      ...(concurrencyScope ? { concurrencyScope } : {}),
      requestInProgress,
      supportsInterruption,
      ...(activeResponseHandle !== undefined ? { activeResponseHandle } : {}),
      ...(abortController ? { abortController } : {}),
      ...(typeof patch.stopSession === 'function'
        ? { stopSession: patch.stopSession }
        : patch.stopSession === null
          ? {}
          : supportsInterruption && previous?.stopSession
            ? { stopSession: previous.stopSession }
            : {}),
      ...(typeof patch.disposeSession === 'function'
        ? { disposeSession: patch.disposeSession }
        : patch.disposeSession === null
          ? {}
          : previous?.disposeSession
            ? { disposeSession: previous.disposeSession }
            : {}),
    };

    this.handles.set(sessionId, next);
    return next;
  }

  markRequestComplete(
    sessionId: string,
  ): ChatSessionRuntimeHandle | undefined {
    const previous = this.handles.get(sessionId);
    if (previous) {
      this.handles.set(sessionId, {
        ...previous,
        requestInProgress: false,
        supportsInterruption: false,
        activeResponseHandle: undefined,
        abortController: undefined,
        stopSession: undefined,
      });
    }
    return previous;
  }

  releaseHandle(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId ? this.handles.delete(normalizedSessionId) : false;
  }

  deleteHandle(sessionId: string | null | undefined): boolean {
    return this.releaseHandle(sessionId);
  }

  clear(): void {
    this.handles.clear();
  }

  values(): IterableIterator<ChatSessionRuntimeHandle> {
    return this.handles.values();
  }

  private hasBlockingConcurrentHandle(
    sessionId: string,
    handle: ChatSessionRuntimeHandle | undefined,
  ): boolean {
    if (!handle || handle.capabilities.canRunConcurrently) {
      return false;
    }

    const targetScope = this.resolveConcurrencyScope(handle);
    for (const candidate of this.handles.values()) {
      if (candidate.sessionId === sessionId
        || !candidate.requestInProgress
        || candidate.capabilities.canRunConcurrently
        || this.resolveConcurrencyScope(candidate) !== targetScope) {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveConcurrencyScope(handle: ChatSessionRuntimeHandle): string {
    return handle.concurrencyScope ?? handle.sessionId;
  }

  private resolveCapabilities(
    capabilities: Partial<ChatSessionRuntimeCapabilities> | null | undefined,
    previous: ChatSessionRuntimeHandle | undefined,
  ): ChatSessionRuntimeCapabilities {
    if (capabilities === null) {
      return { ...DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES };
    }

    return {
      ...DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
      ...(previous?.capabilities ?? {}),
      ...(capabilities ?? {}),
    };
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }
}

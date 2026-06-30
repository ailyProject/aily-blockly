import type {
  IAgentLifecycle,
  IChatCoordination,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import type { ChatTitleRequestProvider } from './chat-title-request.service';
import {
  isResolvedSessionTitleSource,
  normalizeChatSessionTitleSource,
  normalizeChatSessionTitleText,
  type ChatSessionTitleCandidate,
} from '../core/chat-session-title';
import type {
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
} from '../core/chat-runtime-host-contract';

type ChatTitleCoordinatorContext = Pick<ISessionAccess, 'sessionId' | 'sessionTitle' | 'chatService' | 'chatHistoryService'>
  & Pick<IChatCoordination, 'session' | 'lexStream'>
  & Pick<IAgentLifecycle, never>
  & {
    readonly readCurrentViewSessionResource?: () => string | null | undefined;
    readonly updateSessionModelTitle?: (sessionId: string, title: Partial<ChatSessionTitleCandidate>) => void;
    readonly requestHostResourceOperation?: (
      request: ChatRuntimeHostResourceOperationRequest,
    ) => Promise<ChatRuntimeHostResourceOperationResult>;
  };

function isMeaningfulTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTechnicalOrPlaceholderSessionTitle(title: string, sessionId?: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedLower = normalizedTitle.toLowerCase();
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';

  if (normalizedSessionId && normalizedTitle === normalizedSessionId) {
    return true;
  }

  if (/^lex-\d{6,}$/i.test(normalizedTitle)) {
    return true;
  }

  return normalizedLower === 'new session'
    || normalizedLower === 'new chat'
    || normalizedLower === 'current session'
    || normalizedLower === 'untitled'
    || normalizedLower === 'untitled session'
    || normalizedLower === 'untitled chat'
    || normalizedLower === 'chat'
    || normalizedTitle === '新会话'
    || normalizedTitle === '新对话'
    || normalizedTitle === '无标题会话';
}

function isResolvedSessionTitle(value: unknown, sessionId?: string): value is string {
  if (!isMeaningfulTitle(value)) {
    return false;
  }

  return !isTechnicalOrPlaceholderSessionTitle(value.trim(), sessionId);
}

function deriveDefaultTitleFromTurnResponses(turnResponses: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return '';
  }

  for (const turnResponse of turnResponses) {
    const request = (turnResponse as { request?: unknown })?.request;
    const title = deriveDefaultTitleFromRequest(request);
    if (title) {
      return title;
    }
  }

  return '';
}

function deriveDefaultTitleFromRequest(request: unknown): string {
  const direct = readRequestTextCandidate(request);
  if (direct) {
    return direct;
  }

  if (request && typeof request === 'object') {
    const nested = readRequestTextCandidate((request as { message?: unknown }).message);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function readRequestTextCandidate(candidate: unknown): string {
  const text = typeof candidate === 'string'
    ? candidate
    : candidate && typeof candidate === 'object'
      ? ((candidate as { messageText?: unknown }).messageText
        ?? (candidate as { prompt?: unknown }).prompt
        ?? (candidate as { text?: unknown }).text
        ?? (candidate as { content?: unknown }).content)
      : undefined;

  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  return normalized.split('\n')[0]?.trim().substring(0, 200) ?? '';
}

function isResolvedCustomSessionTitle(value: unknown, sessionId: string, defaultTitle: string): value is string {
  if (!isResolvedSessionTitle(value, sessionId)) {
    return false;
  }

  const normalizedValue = value.trim();
  const normalizedDefaultTitle = defaultTitle.trim();
  if (!normalizedDefaultTitle) {
    return true;
  }

  return normalizedValue !== normalizedDefaultTitle;
}

function readLegacyResolvedSessionTitle(
  value: unknown,
  sessionId: string,
  defaultTitle: string,
): string {
  const normalizedValue = normalizeChatSessionTitleText(value);
  if (!normalizedValue) {
    return '';
  }

  return isResolvedCustomSessionTitle(normalizedValue, sessionId, defaultTitle)
    ? normalizedValue
    : '';
}

function readResolvedSessionTitleFromSource(
  value: unknown,
  source: unknown,
  sessionId: string,
  defaultTitle: string,
): string {
  const normalizedValue = normalizeChatSessionTitleText(value);
  if (!normalizedValue) {
    return '';
  }

  return isResolvedSessionTitleSource(source)
    ? (isResolvedSessionTitle(normalizedValue, sessionId) ? normalizedValue : '')
    : readLegacyResolvedSessionTitle(normalizedValue, sessionId, defaultTitle);
}

/**
 * Coordinates session title generation and persistence refresh.
 */
export class ChatTitleCoordinator {
  private readonly generationQueueBySession = new Map<string, Promise<void>>();
  private readonly sealedSessionTitles = new Set<string>();
  private readonly generationAbortControllerBySession = new Map<string, AbortController>();
  private readonly generationVersionBySession = new Map<string, number>();

  constructor(
    private readonly ctx: ChatTitleCoordinatorContext,
    private readonly titleRequestService: ChatTitleRequestProvider,
    private readonly syncManagedSessionTitle?: (sessionId: string, title: Partial<ChatSessionTitleCandidate>) => void,
  ) {}

  generate(content: string, targetSessionIdInput?: string | null): Promise<void> {
    const targetSessionId = normalizeSessionId(targetSessionIdInput);
    const sessionId = targetSessionId || this.readCurrentViewSessionResource();
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!sessionId || !normalizedContent) {
      this.logTitleDebug('skip-invalid-input', {
        sessionId,
        hasSessionId: !!sessionId,
        contentLength: normalizedContent.length,
      });
      return Promise.resolve();
    }

    const scheduledVersion = this.getGenerationVersion(sessionId);

    if (this.sealedSessionTitles.has(sessionId)) {
      this.logTitleDebug('skip-sealed', { sessionId, scheduledVersion });
      return Promise.resolve();
    }

    if (this.hasResolvedSessionTitle(sessionId)) {
      this.logTitleDebug('skip-resolved', { sessionId, scheduledVersion });
      return Promise.resolve();
    }

    const queued = this.generationQueueBySession.get(sessionId) ?? Promise.resolve();
    const next = queued
      .catch(() => undefined)
      .then(async () => {
        if (scheduledVersion !== this.getGenerationVersion(sessionId)) {
          this.logTitleDebug('skip-version-mismatch-before-request', {
            sessionId,
            scheduledVersion,
            currentVersion: this.getGenerationVersion(sessionId),
          });
          return;
        }

        if (this.sealedSessionTitles.has(sessionId)) {
          this.logTitleDebug('skip-sealed-before-request', { sessionId, scheduledVersion });
          return;
        }

        if (this.hasResolvedSessionTitle(sessionId)) {
          this.logTitleDebug('skip-resolved-before-request', { sessionId, scheduledVersion });
          return;
        }

        const abortController = new AbortController();
        this.generationAbortControllerBySession.set(sessionId, abortController);

        this.logTitleDebug('request-start', {
          sessionId,
          scheduledVersion,
          contentLength: normalizedContent.length,
          contentPreview: normalizedContent.slice(0, 120),
        });

        const generated = await this.titleRequestService.generate(normalizedContent, {
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) {
          this.logTitleDebug('skip-aborted-after-request', { sessionId, scheduledVersion });
          return;
        }

        if (scheduledVersion !== this.getGenerationVersion(sessionId)) {
          this.logTitleDebug('skip-version-mismatch-after-request', {
            sessionId,
            scheduledVersion,
            currentVersion: this.getGenerationVersion(sessionId),
          });
          return;
        }

        const title = typeof generated === 'string' ? generated.trim() : '';
        if (!title) {
          this.logTitleDebug('skip-empty-generated-title', { sessionId, scheduledVersion });
          return;
        }

        // Late async completions must not overwrite titles that already resolved meanwhile.
        if (this.hasResolvedSessionTitle(sessionId)) {
          this.logTitleDebug('skip-resolved-after-request', {
            sessionId,
            scheduledVersion,
            generatedTitle: title,
          });
          return;
        }

        const titleCandidate = {
          text: title,
          source: 'generated',
        } as const;
        await this.persistGeneratedTitleThroughHost(sessionId, title);
        this.ctx.updateSessionModelTitle?.(sessionId, titleCandidate);
        this.syncManagedSessionTitle?.(sessionId, titleCandidate);
        this.sealedSessionTitles.add(sessionId);
        if (sessionId === this.readCurrentViewSessionResource()) {
          if (typeof this.ctx.chatService.setCurrentSessionTitle === 'function') {
            this.ctx.chatService.setCurrentSessionTitle({
              text: title,
              source: 'generated',
            });
          } else {
            this.ctx.chatService.currentSessionTitle = title;
          }
        }
        this.logTitleDebug('title-applied', {
          sessionId,
          scheduledVersion,
          title,
        });
      })
      .catch(err => {
        if (this.isAbortError(err)) {
          this.logTitleDebug('request-aborted', { sessionId, scheduledVersion });
          return;
        }
        this.logTitleDebug('request-failed', {
          sessionId,
          scheduledVersion,
          errorName: err instanceof Error ? err.name : '',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        console.warn('[ChatTitleCoordinator] title generation did not complete:', err);
      })
      .finally(() => {
        if (this.generationQueueBySession.get(sessionId) === next) {
          this.generationQueueBySession.delete(sessionId);
        }
        this.generationAbortControllerBySession.delete(sessionId);
      });

    this.generationQueueBySession.set(sessionId, next);
    return next;
  }

  private async persistGeneratedTitleThroughHost(sessionId: string, title: string): Promise<void> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTitle = normalizeChatSessionTitleText(title);
    if (!normalizedSessionId || !normalizedTitle) {
      return;
    }
    if (typeof this.ctx.requestHostResourceOperation !== 'function') {
      throw new Error('[ChatTitleCoordinator] host resource operation bridge is required for generated title persistence.');
    }

    await this.ctx.requestHostResourceOperation({
      sessionId: normalizedSessionId,
      kind: 'history-persistence',
      label: 'Persisting generated chat session title',
      resource: {
        title: normalizedTitle,
        titleSource: 'generated',
      },
      payload: {
        adapter: 'chatHistory',
        record: {
          sessionId: normalizedSessionId,
          metadata: {
            sessionId: normalizedSessionId,
            title: normalizedTitle,
            titleSource: 'generated',
          },
        },
      },
    });
  }

  cancelPendingForSession(sessionId: string | null | undefined): void {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) {
      return;
    }
    this.generationVersionBySession.set(normalized, this.getGenerationVersion(normalized) + 1);
    this.generationAbortControllerBySession.get(normalized)?.abort();
  }

  cancelPendingForCurrentSession(): void {
    this.cancelPendingForSession(this.readCurrentViewSessionResource());
  }

  private hasResolvedSessionTitle(sessionId: string): boolean {
    const persistedEntry = this.ctx.chatHistoryService.findEntry?.(sessionId);
    const persistedRecord = this.ctx.chatHistoryService.loadHostRecord?.(
      sessionId,
      persistedEntry?.projectPath ?? null,
    );
    const defaultTitle = this.readSessionDefaultTitle(sessionId, persistedRecord);

    const currentSessionId = this.readCurrentViewSessionResource();
    if (sessionId === currentSessionId) {
      const liveTitle = normalizeChatSessionTitleText(this.ctx.chatService.currentSessionTitle ?? this.ctx.sessionTitle);
      const liveResolvedTitle = isResolvedSessionTitleSource(this.ctx.chatService.currentSessionTitleSource)
        && isResolvedSessionTitle(liveTitle, sessionId)
        ? liveTitle
        : '';
      if (liveResolvedTitle) {
        return true;
      }
    }

    const resolvedPersistedRecordTitle = readResolvedSessionTitleFromSource(
      persistedRecord?.metadata?.title,
      (persistedRecord?.metadata as { titleSource?: unknown } | undefined)?.titleSource,
      sessionId,
      defaultTitle,
    );
    if (resolvedPersistedRecordTitle) {
      return true;
    }

    const resolvedPersistedEntryTitle = readResolvedSessionTitleFromSource(
      persistedEntry?.title,
      (persistedEntry as { titleSource?: unknown } | undefined)?.titleSource,
      sessionId,
      defaultTitle,
    );
    if (resolvedPersistedEntryTitle) {
      return true;
    }

    return false;
  }

  private readSessionDefaultTitle(sessionId: string, persistedRecord?: { turnResponses?: readonly unknown[] } | null): string {
    if (sessionId === this.readCurrentViewSessionResource()) {
      const liveTurnResponses = (this.ctx.lexStream as { turnResponses?: readonly unknown[] } | undefined)?.turnResponses;
      const liveDefaultTitle = deriveDefaultTitleFromTurnResponses(liveTurnResponses);
      if (liveDefaultTitle) {
        return liveDefaultTitle;
      }
    }

    return deriveDefaultTitleFromTurnResponses(persistedRecord?.turnResponses);
  }

  private readCurrentViewSessionResource(): string {
    const viewResource = this.ctx.readCurrentViewSessionResource?.();
    const normalizedViewResource = normalizeSessionId(viewResource);
    return normalizedViewResource;
  }

  private isAbortError(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return error.name === 'AbortError';
    }
    return error instanceof Error && error.name === 'AbortError';
  }

  private getGenerationVersion(sessionId: string): number {
    return this.generationVersionBySession.get(sessionId) ?? 0;
  }

  private logTitleDebug(event: string, details: Record<string, unknown>): void {
    console.info('[AilyChat][TitleCoordinator]', {
      event,
      ...details,
    });
  }
}

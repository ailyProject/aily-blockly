import type { AgentHandle } from 'aily-lex/browser';
import { setActiveBlocklySlashCommandSession } from '../core/blockly-slash-command-provider';
import { extractChatAgentRuntimeModeFromConfigKey } from '../core/chat-agent-runtime-mode';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';

type AilyLexModule = import('./lex-agent-bootstrap').AilyLexModule;
type BlocklyLexAgentInstance = InstanceType<AilyLexModule['AilyLexAgent']>;
type LexAgentCreationResult = BlocklyLexAgentInstance | AgentHandle;
type LexSessionSnapshot = ReturnType<AgentHandle['saveSession']>;

interface LexSessionRuntimeEntry {
  readonly sessionId: string;
  agent: BlocklyLexAgentInstance;
  handle: AgentHandle | null;
  configKey: string | null;
  todoUnsubscribe: (() => void) | null;
  abortController: AbortController | null;
}

export interface LexSessionRuntimeEntryProjection {
  readonly sessionId: string;
  readonly configKey: string | null;
  readonly hasHandle: boolean;
  readonly stopSession: () => void;
  readonly disposeSession: () => void;
}

function isAgentHandle(value: LexAgentCreationResult): value is AgentHandle {
  return typeof (value as AgentHandle).chat === 'function'
    && typeof (value as AgentHandle).saveSession === 'function'
    && !!(value as AgentHandle).agent;
}

function isLexAgentLifecycleTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceLexAgentLifecycle', [
    '__AILY_CHAT_TRACE_LEX_AGENT_LIFECYCLE__',
    'AILY_CHAT_TRACE_LEX_AGENT_LIFECYCLE',
  ]);
}

function shortConfigKeyHash(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class LexAgentLifecycleBridge {
  private _lex: AilyLexModule | null = null;
  private _activeSessionId: string | null = null;
  private _loadPromise: Promise<boolean> | null = null;
  private readonly _sessionEntries = new Map<string, LexSessionRuntimeEntry>();

  constructor(
    private readonly deps: {
      getSessionId: () => string;
      createAgent: (
        lex: AilyLexModule,
        sessionId: string,
        configKey: string | null,
      ) => LexAgentCreationResult;
      loadModule: () => Promise<AilyLexModule>;
      onAgentReady?: (
        agent: BlocklyLexAgentInstance,
        lex: AilyLexModule,
        currentTodoUnsubscribe: (() => void) | null,
      ) => (() => void) | null;
      onEntryReady?: (entry: LexSessionRuntimeEntryProjection) => void;
      onEntryDisposed?: (sessionId: string) => void;
    },
  ) {}

  private get activeEntry(): LexSessionRuntimeEntry | null {
    return this.resolveEntry(this._activeSessionId);
  }

  getAgent(sessionId?: string | null): BlocklyLexAgentInstance | null {
    return this.resolveEntry(sessionId)?.agent ?? null;
  }

  getHandle(sessionId?: string | null): AgentHandle | null {
    return this.resolveEntry(sessionId)?.handle ?? null;
  }

  getLex(): AilyLexModule | null {
    return this._lex;
  }

  getSessionIds(): readonly string[] {
    return [...this._sessionEntries.keys()];
  }

  saveSession(sessionId?: string | null): LexSessionSnapshot | null {
    const entry = this.resolveEntry(sessionId);
    return entry?.handle?.saveSession?.()
      ?? entry?.agent.saveSession?.()
      ?? null;
  }

  getSessionSnapshot(sessionId?: string | null): LexSessionSnapshot | null {
    const entry = this.resolveEntry(sessionId);
    return entry?.handle?.getSessionSnapshot?.()
      ?? entry?.agent.getSessionSnapshot?.()
      ?? null;
  }

  isConfiguredFor(sessionId?: string, configKey?: string): boolean {
    const targetSessionId = normalizeLexSessionId(sessionId)
      || normalizeLexSessionId(this.deps.getSessionId());
    if (!targetSessionId) {
      return false;
    }
    const entry = this._sessionEntries.get(targetSessionId);
    if (!entry) {
      return false;
    }

    if (typeof configKey === 'string') {
      return entry.configKey === configKey;
    }

    return true;
  }

  setAbortController(sessionId: string | null | undefined, controller: AbortController | null): void {
    const targetEntry = this.resolveEntry(sessionId);
    if (!targetEntry) {
      return;
    }

    targetEntry.abortController = controller;
  }

  async loadModule(): Promise<boolean> {
    if (this._lex) {
      return true;
    }

    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        try {
          this._lex = await this.deps.loadModule();
          if (isLexAgentLifecycleTraceEnabled()) {
            console.log('[LexStream] aily-lex 模块加载成功');
          }
          return true;
        } catch (err) {
          console.warn('[LexStream] aily-lex 模块不可用:', err);
          this._loadPromise = null;
          return false;
        }
      })();
    }

    return this._loadPromise;
  }

  activateSession(sessionId?: string | null): boolean {
    const targetSessionId = this.resolveSessionId(sessionId);
    if (!targetSessionId) {
      return false;
    }
    const targetEntry = this._sessionEntries.get(targetSessionId) ?? null;
    if (!targetEntry) {
      return false;
    }

    this._activeSessionId = targetEntry.sessionId;
    setActiveBlocklySlashCommandSession(targetEntry.sessionId);
    return true;
  }

  async ensureAgent(
    sessionId?: string,
    configKey?: string,
    options?: { readonly activate?: boolean },
  ): Promise<boolean> {
    const startedAt = Date.now();
    const targetSessionId = normalizeLexSessionId(sessionId)
      || normalizeLexSessionId(this.deps.getSessionId());
    if (!targetSessionId) {
      if (isLexAgentLifecycleTraceEnabled()) {
        console.info('[LexStream][debug] ensureAgent skipped without session owner', {
          requestedSessionId: sessionId ?? null,
          requestedConfigKey: typeof configKey === 'string' ? configKey : null,
          durationMs: Date.now() - startedAt,
        });
      }
      return false;
    }

    if (!await this.loadModule()) {
      if (isLexAgentLifecycleTraceEnabled()) {
        console.info('[LexStream][debug] ensureAgent loadModule unavailable', {
          requestedSessionId: sessionId ?? null,
          requestedConfigKey: typeof configKey === 'string' ? configKey : null,
          durationMs: Date.now() - startedAt,
        });
      }
      return false;
    }

    const lex = this._lex!;
    const normalizedConfigKey = typeof configKey === 'string' ? configKey : null;
    const existingEntry = this._sessionEntries.get(targetSessionId) ?? null;
    const shouldActivate = options?.activate !== false;

    if (isLexAgentLifecycleTraceEnabled()) {
      console.info('[LexStream][debug] ensureAgent start', {
        targetSessionId,
        requestedConfigKey: normalizedConfigKey,
        requestedRuntimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
        activeSessionId: this._activeSessionId,
        hasExistingEntry: !!existingEntry,
        existingConfigKey: existingEntry?.configKey ?? null,
        existingRuntimeMode: extractChatAgentRuntimeModeFromConfigKey(existingEntry?.configKey ?? null) ?? null,
      });
    }

    if (existingEntry) {
      if (normalizedConfigKey !== null) {
        if (existingEntry.configKey === normalizedConfigKey) {
          if (shouldActivate) {
            this.activateSession(targetSessionId);
          }
          if (isLexAgentLifecycleTraceEnabled()) {
            console.info('[LexStream][debug] ensureAgent reused existing entry', {
              targetSessionId,
              reuseReason: shouldActivate ? 'config-match' : 'config-match-acquire-only',
              durationMs: Date.now() - startedAt,
            });
          }
          this.publishSessionEntry(existingEntry);
          return true;
        }
      } else if (!shouldActivate || this._activeSessionId !== targetSessionId) {
        if (shouldActivate) {
          this.activateSession(targetSessionId);
        }
        if (isLexAgentLifecycleTraceEnabled()) {
          console.info('[LexStream][debug] ensureAgent reused existing entry', {
            targetSessionId,
            reuseReason: shouldActivate ? 'active-session-switch' : 'acquire-only',
            durationMs: Date.now() - startedAt,
          });
        }
        this.publishSessionEntry(existingEntry);
        return true;
      }
    }

    const snapshotToRestore = this.captureLiveSessionSnapshot(existingEntry);
    if (existingEntry) {
      if (isLexAgentLifecycleTraceEnabled()) {
        console.info('[LexStream][debug] ensureAgent rebuilding entry', {
          targetSessionId,
          previousConfigKey: existingEntry.configKey,
          nextConfigKey: normalizedConfigKey,
          previousRuntimeMode: extractChatAgentRuntimeModeFromConfigKey(existingEntry.configKey) ?? null,
          nextRuntimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
          hasSnapshotToRestore: !!snapshotToRestore,
        });
      }
    }
    if (existingEntry) {
      this.disposeSessionEntry(existingEntry);
    }

    console.info('[AilyChat][LexAgentLifecycleTrace]', {
      phase: 'create-agent-enter',
      targetSessionId,
      configKey: normalizedConfigKey,
      configKeyHash: shortConfigKeyHash(normalizedConfigKey),
      existingConfigKeyHash: shortConfigKeyHash(existingEntry?.configKey),
      runtimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
      hadExistingEntry: !!existingEntry,
      hasSnapshotToRestore: !!snapshotToRestore,
    });
    let created: LexAgentCreationResult;
    try {
      created = this.deps.createAgent(lex, targetSessionId, normalizedConfigKey);
      console.info('[AilyChat][LexAgentLifecycleTrace]', {
        phase: 'create-agent-created',
        targetSessionId,
        configKey: normalizedConfigKey,
        configKeyHash: shortConfigKeyHash(normalizedConfigKey),
        runtimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
      });
    } catch (error) {
      console.error('[AilyChat][LexAgentLifecycleTrace]', {
        phase: 'create-agent-failed',
        targetSessionId,
        configKey: normalizedConfigKey,
        runtimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
    const nextEntry = this.createSessionEntry(targetSessionId, created, normalizedConfigKey);
    this._sessionEntries.set(targetSessionId, nextEntry);
    if (shouldActivate) {
      this.activateSession(targetSessionId);
    }

    if (snapshotToRestore) {
      try {
        this.restoreLiveSessionSnapshot(nextEntry, snapshotToRestore);
      } catch (error) {
        console.warn('[LexStream] restore rebuilt agent snapshot failed:', error);
      }
    }

    nextEntry.todoUnsubscribe = this.deps.onAgentReady?.(nextEntry.agent, lex, nextEntry.todoUnsubscribe) ?? nextEntry.todoUnsubscribe;
    this.publishSessionEntry(nextEntry);
    if (isLexAgentLifecycleTraceEnabled()) {
      console.info('[LexStream][debug] ensureAgent ready', {
        targetSessionId,
        configKey: normalizedConfigKey,
        runtimeMode: extractChatAgentRuntimeModeFromConfigKey(normalizedConfigKey) ?? null,
        restoredSnapshot: !!snapshotToRestore,
        durationMs: Date.now() - startedAt,
      });
    }
    return true;
  }

  stop(sessionId?: string): void {
    const targetEntry = this.resolveEntry(sessionId);
    if (!targetEntry) {
      return;
    }

    targetEntry.abortController?.abort();
    targetEntry.abortController = null;

    targetEntry.handle?.abort?.('用户取消');
    if (!targetEntry.handle) {
      targetEntry.agent.abort?.('用户取消');
    }
  }

  dispose(sessionId?: string): void {
    const targetSessionId = this.resolveSessionId(sessionId);
    const targetEntry = this.resolveEntry(sessionId);
    if (!targetEntry) {
      if (!targetSessionId) {
        this._activeSessionId = null;
      }
      return;
    }

    this.stop(targetEntry.sessionId);
    this._sessionEntries.delete(targetEntry.sessionId);
    this.disposeSessionEntry(targetEntry);
    this.deps.onEntryDisposed?.(targetEntry.sessionId);
    if (targetEntry.sessionId === this._activeSessionId) {
      this._activeSessionId = null;
      setActiveBlocklySlashCommandSession(null);
    }
  }

  disposeAll(): void {
    this.stop();
    for (const entry of this._sessionEntries.values()) {
      this.disposeSessionEntry(entry);
      this.deps.onEntryDisposed?.(entry.sessionId);
    }
    this._sessionEntries.clear();
    this._activeSessionId = null;
    setActiveBlocklySlashCommandSession(null);
  }

  private createSessionEntry(
    sessionId: string,
    created: LexAgentCreationResult,
    configKey: string | null,
  ): LexSessionRuntimeEntry {
    if (isAgentHandle(created)) {
      return {
        sessionId,
        agent: created.agent as BlocklyLexAgentInstance,
        handle: created,
        configKey,
        todoUnsubscribe: null,
        abortController: null,
      };
    }

    return {
      sessionId,
      agent: created,
      handle: null,
      configKey,
      todoUnsubscribe: null,
      abortController: null,
    };
  }

  private disposeSessionEntry(entry: LexSessionRuntimeEntry): void {
    entry.abortController?.abort();
    entry.abortController = null;
    entry.todoUnsubscribe?.();
    entry.todoUnsubscribe = null;

    if (entry.handle) {
      entry.handle.dispose();
      return;
    }

    entry.agent.dispose();
  }

  private publishSessionEntry(entry: LexSessionRuntimeEntry): void {
    this.deps.onEntryReady?.({
      sessionId: entry.sessionId,
      configKey: entry.configKey,
      hasHandle: !!entry.handle,
      stopSession: () => this.stop(entry.sessionId),
      disposeSession: () => this.dispose(entry.sessionId),
    });
  }

  private resolveSessionId(sessionId?: string | null): string | null {
    if (typeof sessionId === 'string') {
      return normalizeLexSessionId(sessionId) || null;
    }

    if (sessionId === null) {
      return null;
    }

    return this._activeSessionId;
  }

  private resolveEntry(sessionId?: string | null): LexSessionRuntimeEntry | null {
    const targetSessionId = this.resolveSessionId(sessionId);
    return targetSessionId
      ? this._sessionEntries.get(targetSessionId) ?? null
      : null;
  }

  private captureLiveSessionSnapshot(entry: LexSessionRuntimeEntry | null): LexSessionSnapshot | null {
    const snapshot = entry?.handle?.saveSession?.()
      ?? entry?.agent.saveSession?.()
      ?? null;
    return snapshot?.sessionId === entry?.sessionId
      ? snapshot
      : null;
  }

  private restoreLiveSessionSnapshot(entry: LexSessionRuntimeEntry, snapshot: LexSessionSnapshot): void {
    if (entry.handle?.restoreSession) {
      entry.handle.restoreSession(snapshot);
      return;
    }

    entry.agent.restoreSession?.(snapshot);
  }
}

function normalizeLexSessionId(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { AilyHost } from '../core/host';

export interface PersistedChatSessionState {
  readonly archived?: boolean;
  readonly pinned?: boolean;
  readonly read?: number;
}

export interface ResolvedChatSessionState {
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly read: boolean;
  readonly markedUnread: boolean;
}

export interface ChatSessionStateScopeSnapshot {
  readonly readDateBaseline: number;
  readonly sessions: Readonly<Record<string, PersistedChatSessionState>>;
}

interface PersistedChatSessionStateEnvelope {
  readonly version: 1;
  readonly readDateBaseline: number;
  readonly sessions: Record<string, PersistedChatSessionState>;
}

interface LoadedChatSessionStateScope {
  readonly scopeKey: string;
  readonly filePath: string;
  readDateBaseline: number;
  sessions: Record<string, PersistedChatSessionState>;
}

@Injectable({
  providedIn: 'root',
})
export class ChatSessionStateService {
  private readonly STATE_FILE = 'chat_session_state.json';
  private readonly GLOBAL_CHAT_DATA_DIR = 'chat_history';
  private readonly PROJECT_CHAT_DIR = '.chat_history';
  private readonly UNREAD_MARKER = -1;
  private readonly READ_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  private readonly scopes = new Map<string, LoadedChatSessionStateScope>();
  private readonly stateChangedSubject = new Subject<{ readonly sessionId: string }>();
  readonly sessionStateChanged$ = this.stateChangedSubject.asObservable();

  readSessionState(
    sessionId: string,
    projectPathHint?: string | null,
  ): PersistedChatSessionState {
    if (!sessionId) {
      return {};
    }

    const scope = this.loadScope(projectPathHint ?? null);
    return { ...(scope.sessions[sessionId] ?? {}) };
  }

  readScopeSnapshot(projectPathHint?: string | null): ChatSessionStateScopeSnapshot {
    const scope = this.loadScope(projectPathHint ?? null);
    return {
      readDateBaseline: scope.readDateBaseline,
      sessions: scope.sessions,
    };
  }

  resolveSessionState(
    sessionId: string,
    options?: {
      readonly projectPath?: string | null;
      readonly providerArchived?: boolean;
      readonly trackingTime?: number;
    },
  ): ResolvedChatSessionState {
    const scope = this.loadScope(options?.projectPath ?? null);
    const state = scope.sessions[sessionId] ?? {};
    const archived = state.archived ?? options?.providerArchived === true;
    const pinned = state.pinned === true;
    const markedUnread = state.read === this.UNREAD_MARKER;

    let read = archived;
    if (!read) {
      const readDate = Math.max(
        typeof state.read === 'number' && state.read !== this.UNREAD_MARKER ? state.read : 0,
        scope.readDateBaseline,
      );
      const trackingTime = typeof options?.trackingTime === 'number'
        ? options.trackingTime
        : 0;
      read = !markedUnread && readDate >= trackingTime - 2000;
    }

    return {
      archived,
      pinned,
      read,
      markedUnread,
    };
  }

  setArchived(
    sessionId: string,
    projectPathHint: string | null | undefined,
    archived: boolean,
    trackingTime?: number,
  ): void {
    if (!sessionId) {
      return;
    }

    if (archived) {
      this.setRead(sessionId, projectPathHint, true, trackingTime, true);
    }

    const scope = this.loadScope(projectPathHint ?? null);
    const current = scope.sessions[sessionId] ?? {};
    if ((current.archived ?? false) === archived) {
      return;
    }

    this.writeSessionState(scope, sessionId, {
      ...current,
      archived,
    });
  }

  setPinned(
    sessionId: string,
    projectPathHint: string | null | undefined,
    pinned: boolean,
  ): void {
    if (!sessionId) {
      return;
    }

    const scope = this.loadScope(projectPathHint ?? null);
    const current = scope.sessions[sessionId] ?? {};
    if ((current.pinned ?? false) === pinned) {
      return;
    }

    this.writeSessionState(scope, sessionId, {
      ...current,
      pinned,
    });
  }

  setRead(
    sessionId: string,
    projectPathHint: string | null | undefined,
    read: boolean,
    trackingTime?: number,
    skipEvent: boolean = false,
  ): void {
    if (!sessionId) {
      return;
    }

    const scope = this.loadScope(projectPathHint ?? null);
    const current = scope.sessions[sessionId] ?? {};
    const nextReadValue = read
      ? Math.max(Date.now(), typeof trackingTime === 'number' ? trackingTime : 0)
      : this.UNREAD_MARKER;

    if (current.read === nextReadValue) {
      return;
    }

    if (
      read
      && typeof current.read === 'number'
      && current.read !== this.UNREAD_MARKER
      && current.read >= nextReadValue
    ) {
      return;
    }

    this.writeSessionState(scope, sessionId, {
      ...current,
      read: nextReadValue,
    }, skipEvent);
  }

  clearSessionState(
    sessionId: string,
    projectPathHint?: string | null,
  ): void {
    if (!sessionId) {
      return;
    }

    const clearedScopeKeys = new Set<string>();
    const scopeHints = [projectPathHint ?? null, null];
    for (const scopeHint of scopeHints) {
      const scope = this.loadScope(scopeHint);
      if (clearedScopeKeys.has(scope.scopeKey) || !scope.sessions[sessionId]) {
        continue;
      }

      delete scope.sessions[sessionId];
      this.persistScope(scope);
      clearedScopeKeys.add(scope.scopeKey);
    }

    for (const scope of this.scopes.values()) {
      if (clearedScopeKeys.has(scope.scopeKey) || !scope.sessions[sessionId]) {
        continue;
      }

      delete scope.sessions[sessionId];
      this.persistScope(scope);
      clearedScopeKeys.add(scope.scopeKey);
    }

    if (clearedScopeKeys.size > 0) {
      this.stateChangedSubject.next({ sessionId });
    }
  }

  private writeSessionState(
    scope: LoadedChatSessionStateScope,
    sessionId: string,
    state: PersistedChatSessionState,
    skipEvent: boolean = false,
  ): void {
    const normalized = this.normalizeState(state);
    if (normalized) {
      scope.sessions[sessionId] = normalized;
    } else {
      delete scope.sessions[sessionId];
    }

    this.persistScope(scope);
    if (!skipEvent) {
      this.stateChangedSubject.next({ sessionId });
    }
  }

  private normalizeState(state: PersistedChatSessionState): PersistedChatSessionState | null {
    const archived = state.archived === true ? true : undefined;
    const pinned = state.pinned === true ? true : undefined;
    const read = typeof state.read === 'number' && Number.isFinite(state.read)
      ? state.read
      : undefined;

    if (archived === undefined && pinned === undefined && read === undefined) {
      return null;
    }

    return {
      ...(archived !== undefined ? { archived } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(read !== undefined ? { read } : {}),
    };
  }

  private loadScope(projectPath: string | null): LoadedChatSessionStateScope {
    const scopeDescriptor = this.resolveScope(projectPath);
    const cached = this.scopes.get(scopeDescriptor.scopeKey);
    if (cached) {
      return cached;
    }

    const emptyScope: LoadedChatSessionStateScope = {
      scopeKey: scopeDescriptor.scopeKey,
      filePath: scopeDescriptor.filePath,
      readDateBaseline: Date.now() - this.READ_STATE_WINDOW_MS,
      sessions: {},
    };

    if (!scopeDescriptor.filePath || !this.fileExists(scopeDescriptor.filePath)) {
      this.scopes.set(scopeDescriptor.scopeKey, emptyScope);
      return emptyScope;
    }

    try {
      const raw = this.readFile(scopeDescriptor.filePath);
      const parsed = JSON.parse(raw) as Partial<PersistedChatSessionStateEnvelope>;
      const loadedScope: LoadedChatSessionStateScope = {
        scopeKey: scopeDescriptor.scopeKey,
        filePath: scopeDescriptor.filePath,
        readDateBaseline: typeof parsed.readDateBaseline === 'number' && Number.isFinite(parsed.readDateBaseline)
          ? parsed.readDateBaseline
          : emptyScope.readDateBaseline,
        sessions: this.normalizeSessions(parsed.sessions),
      };
      this.scopes.set(scopeDescriptor.scopeKey, loadedScope);
      return loadedScope;
    } catch (error) {
      console.warn('[ChatSessionState] 加载 session state 失败:', error);
      this.scopes.set(scopeDescriptor.scopeKey, emptyScope);
      return emptyScope;
    }
  }

  private normalizeSessions(raw: unknown): Record<string, PersistedChatSessionState> {
    if (!raw || typeof raw !== 'object') {
      return {};
    }

    const entries = Object.entries(raw as Record<string, unknown>);
    const sessions: Record<string, PersistedChatSessionState> = {};
    for (const [sessionId, value] of entries) {
      if (!sessionId) {
        continue;
      }

      const normalized = this.normalizeState((value ?? {}) as PersistedChatSessionState);
      if (normalized) {
        sessions[sessionId] = normalized;
      }
    }

    return sessions;
  }

  private persistScope(scope: LoadedChatSessionStateScope): void {
    if (!scope.filePath || !this.hasFs()) {
      return;
    }

    try {
      this.ensureDir(this.dirname(scope.filePath));
      const payload: PersistedChatSessionStateEnvelope = {
        version: 1,
        readDateBaseline: scope.readDateBaseline,
        sessions: scope.sessions,
      };
      this.writeFile(scope.filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.warn('[ChatSessionState] 保存 session state 失败:', error);
    }
  }

  private resolveScope(projectPath: string | null): { readonly scopeKey: string; readonly filePath: string } {
    const normalizedProjectPath = this.normalizePath(projectPath);
    if (normalizedProjectPath) {
      return {
        scopeKey: `project:${normalizedProjectPath}`,
        filePath: this.joinPath(normalizedProjectPath, this.PROJECT_CHAT_DIR, this.STATE_FILE),
      };
    }

    const globalDir = this.joinPath(this.getGlobalAilyDir(), this.GLOBAL_CHAT_DATA_DIR);
    return {
      scopeKey: 'global',
      filePath: globalDir ? this.joinPath(globalDir, this.STATE_FILE) : '',
    };
  }

  private normalizePath(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim().replace(/[\\/]+$/, '')
      : null;
  }

  private dirname(filePath: string): string {
    const normalized = filePath.replace(/[\\/]+$/, '');
    const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    return lastSeparator > 0 ? normalized.slice(0, lastSeparator) : normalized;
  }

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!AilyHost.get().fs;
  }

  private fileExists(path: string): boolean {
    try {
      return this.hasFs() && AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }

  private readFile(path: string): string {
    return AilyHost.get().fs.readFileSync(path, 'utf-8');
  }

  private writeFile(path: string, content: string): void {
    AilyHost.get().fs.writeFileSync(path, content, 'utf-8');
  }

  private ensureDir(dirPath: string): void {
    if (!dirPath || this.fileExists(dirPath)) {
      return;
    }

    AilyHost.get().fs.mkdirSync(dirPath, { recursive: true });
  }

  private joinPath(...parts: string[]): string {
    if (AilyHost.get().path?.join) {
      return AilyHost.get().path.join(...parts);
    }

    return parts.join('/').replace(/\/+/g, '/');
  }

  private getGlobalAilyDir(): string {
    return AilyHost.get().path?.getAppDataPath?.() || '';
  }
}
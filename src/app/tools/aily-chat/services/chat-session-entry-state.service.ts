import { Injectable } from '@angular/core';

import type { ChatSessionInputState, ChatSurfaceModeId } from '../core/chat-mode';
import { normalizeChatSurfaceModeId } from '../core/chat-mode';
import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import { AilyHost } from '../core/host';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';
import { normalizeHostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { HostSessionRequestRoutingSummary } from '../helpers/host-session-request-routing';
import { normalizeHostSessionRequestRoutingSummary } from '../helpers/host-session-request-routing';

export interface PersistedChatSessionEntryTarget {
  readonly sessionId: string;
  readonly projectPath?: string | null;
  readonly providerOptions?: HostSessionProviderOptions;
  readonly inputState?: ChatSessionInputState;
  readonly mode?: ChatSurfaceModeId;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode;
  readonly runtimeMode?: ChatAgentRuntimeMode;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  readonly runtimeModeSource?: ChatAgentRuntimeModeSource;
  readonly requestRouting?: HostSessionRequestRoutingSummary | null;
}

interface PersistedChatSessionEntryStateEnvelope {
  readonly version: 1;
  readonly target?: PersistedChatSessionEntryTarget | null;
}

interface LoadedChatSessionEntryStateScope {
  readonly scopeKey: string;
  readonly filePath: string;
  target: PersistedChatSessionEntryTarget | null;
}

@Injectable({
  providedIn: 'root',
})
export class ChatSessionEntryStateService {
  private readonly STATE_FILE = 'chat_session_entry_state.json';
  private readonly GLOBAL_CHAT_DATA_DIR = 'chat_history';
  private readonly PROJECT_CHAT_DIR = '.chat_history';
  private readonly scopes = new Map<string, LoadedChatSessionEntryStateScope>();

  readSessionEntryTarget(projectPathHint?: string | null): PersistedChatSessionEntryTarget | null {
    const scope = this.loadScope(projectPathHint ?? null);
    const target = scope.target ? this.cloneTarget(scope.target) : null;
    if (!projectPathHint && this.targetHasProjectScope(target)) {
      return null;
    }
    return target;
  }

  setSessionEntryTarget(
    target: PersistedChatSessionEntryTarget | null | undefined,
    projectPathHint?: string | null,
  ): void {
    const scope = this.loadScope(projectPathHint ?? null);
    const normalized = this.normalizeTarget(target ?? null);
    const current = JSON.stringify(scope.target ?? null);
    const next = JSON.stringify(normalized ?? null);
    if (current === next) {
      return;
    }

    scope.target = normalized;
    this.persistScope(scope);
  }

  clearSessionEntryTarget(
    sessionId?: string | null,
    projectPathHint?: string | null,
  ): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const clearedScopeKeys = new Set<string>();
    const scopeHints = [projectPathHint ?? null, null];

    for (const scopeHint of scopeHints) {
      const scope = this.loadScope(scopeHint);
      if (clearedScopeKeys.has(scope.scopeKey) || !this.shouldClearTarget(scope.target, normalizedSessionId)) {
        continue;
      }

      scope.target = null;
      this.persistScope(scope);
      clearedScopeKeys.add(scope.scopeKey);
    }

    for (const scope of this.scopes.values()) {
      if (clearedScopeKeys.has(scope.scopeKey) || !this.shouldClearTarget(scope.target, normalizedSessionId)) {
        continue;
      }

      scope.target = null;
      this.persistScope(scope);
      clearedScopeKeys.add(scope.scopeKey);
    }
  }

  private shouldClearTarget(target: PersistedChatSessionEntryTarget | null, sessionId: string): boolean {
    if (!target) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return target.sessionId === sessionId;
  }

  private targetHasProjectScope(target: PersistedChatSessionEntryTarget | null): boolean {
    if (!target) {
      return false;
    }

    return this.normalizePath(target.projectPath) !== null
      || this.normalizePath(target.providerOptions?.folderPath) !== null;
  }

  private loadScope(projectPath: string | null): LoadedChatSessionEntryStateScope {
    const scopeDescriptor = this.resolveScope(projectPath);
    const cached = this.scopes.get(scopeDescriptor.scopeKey);
    if (cached) {
      return cached;
    }

    const emptyScope: LoadedChatSessionEntryStateScope = {
      scopeKey: scopeDescriptor.scopeKey,
      filePath: scopeDescriptor.filePath,
      target: null,
    };

    if (!scopeDescriptor.filePath || !this.fileExists(scopeDescriptor.filePath)) {
      this.scopes.set(scopeDescriptor.scopeKey, emptyScope);
      return emptyScope;
    }

    try {
      const raw = this.readFile(scopeDescriptor.filePath);
      const parsed = JSON.parse(raw) as Partial<PersistedChatSessionEntryStateEnvelope>;
      const loadedScope: LoadedChatSessionEntryStateScope = {
        scopeKey: scopeDescriptor.scopeKey,
        filePath: scopeDescriptor.filePath,
        target: this.normalizeTarget(parsed.target ?? null),
      };
      this.scopes.set(scopeDescriptor.scopeKey, loadedScope);
      return loadedScope;
    } catch (error) {
      console.warn('[ChatSessionEntryState] 加载 session entry state 失败:', error);
      this.scopes.set(scopeDescriptor.scopeKey, emptyScope);
      return emptyScope;
    }
  }

  private persistScope(scope: LoadedChatSessionEntryStateScope): void {
    if (!scope.filePath || !this.hasFs()) {
      return;
    }

    try {
      this.ensureDir(this.dirname(scope.filePath));
      const payload: PersistedChatSessionEntryStateEnvelope = {
        version: 1,
        ...(scope.target ? { target: scope.target } : {}),
      };
      this.writeFile(scope.filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.warn('[ChatSessionEntryState] 保存 session entry state 失败:', error);
    }
  }

  private normalizeTarget(raw: PersistedChatSessionEntryTarget | null): PersistedChatSessionEntryTarget | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!sessionId) {
      return null;
    }

    const projectPath = this.normalizePath(raw.projectPath);
    const mode = typeof raw.mode === 'string' && raw.mode.trim().length > 0
      ? normalizeChatSurfaceModeId(raw.mode)
      : undefined;
    const rawAgentRuntimeMode = raw.agentRuntimeMode ?? raw.runtimeMode;
    const agentRuntimeMode = typeof rawAgentRuntimeMode === 'string' && rawAgentRuntimeMode.trim().length > 0
      ? normalizeChatAgentRuntimeMode(rawAgentRuntimeMode)
      : undefined;
    const rawAgentRuntimeModeSource = raw.agentRuntimeModeSource ?? raw.runtimeModeSource;
    const agentRuntimeModeSource = typeof rawAgentRuntimeModeSource === 'string' && rawAgentRuntimeModeSource.trim().length > 0
      ? normalizeChatAgentRuntimeModeSource(rawAgentRuntimeModeSource)
      : undefined;
    const providerOptions = this.normalizeProviderOptions(raw.providerOptions, projectPath);
    const inputState = this.cloneJsonValue(raw.inputState);
    const requestRouting = this.normalizeRequestRouting(raw.requestRouting, mode ?? 'agent');

    return {
      sessionId,
      ...(projectPath !== null ? { projectPath } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(inputState ? { inputState } : {}),
      ...(mode ? { mode } : {}),
      ...(agentRuntimeMode ? { agentRuntimeMode } : {}),
      ...(agentRuntimeModeSource ? { agentRuntimeModeSource } : {}),
      ...(requestRouting ? { requestRouting } : {}),
    };
  }

  private normalizeProviderOptions(
    providerOptions: HostSessionProviderOptions | undefined,
    projectPath: string | null,
  ): HostSessionProviderOptions | undefined {
    const normalized = normalizeHostSessionProviderOptions(providerOptions, {
      folderPath: projectPath,
    });

    if (
      normalized.folderPath == null
      && normalized.permissionMode === undefined
      && normalized.permissionLevel === undefined
      && normalized.approvalsReviewer === undefined
      && normalized.approvalPolicy === undefined
    ) {
      return undefined;
    }

    return normalized;
  }

  private normalizeRequestRouting(
    requestRouting: PersistedChatSessionEntryTarget['requestRouting'],
    fallback: string,
  ): PersistedChatSessionEntryTarget['requestRouting'] | undefined {
    if (!requestRouting) {
      return undefined;
    }

    const normalized = normalizeHostSessionRequestRoutingSummary(requestRouting, fallback);
    if (
      !normalized.selectedModeId
      && !normalized.requestModeId
      && !normalized.customAgentTarget
      && !normalized.permissionLevel
      && !normalized.approvalsReviewer
      && !normalized.approvalPolicy
    ) {
      return undefined;
    }

    return normalized;
  }

  private cloneTarget(target: PersistedChatSessionEntryTarget): PersistedChatSessionEntryTarget {
    return this.normalizeTarget(target) ?? { sessionId: target.sessionId };
  }

  private cloneJsonValue<T>(value: T): T | undefined {
    if (value == null) {
      return undefined;
    }

    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return undefined;
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

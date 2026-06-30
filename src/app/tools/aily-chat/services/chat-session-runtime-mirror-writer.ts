import { Injectable, InjectionToken } from '@angular/core';

import type {
  ChatSessionRuntimeChangeOptions,
  ChatSessionRuntimeState,
  ChatSessionRuntimeStatePatch,
} from './chat-session-runtime-store.service';
import { ChatSessionRuntimeStoreService } from './chat-session-runtime-store.service';

export interface ChatSessionRuntimeMirrorStorePort {
  read(sessionId: string | null | undefined): ChatSessionRuntimeState | undefined;
  getSessionIds(): readonly string[];
  replaceRuntimeState(
    sessionId: string | null | undefined,
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  clearSession(
    sessionId: string | null | undefined,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  clearAll(): void;
}

export interface ChatSessionRuntimeMirrorWriterPort {
  read(sessionId: string | null | undefined): ChatSessionRuntimeState | undefined;
  hasSession(sessionId: string | null | undefined): boolean;
  getSessionIds(): readonly string[];
  write(
    sessionId: string | null | undefined,
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): boolean;
  clearSession(
    sessionId: string | null | undefined,
    options?: ChatSessionRuntimeChangeOptions,
  ): boolean;
  clearAll(): void;
}

export const CHAT_SESSION_RUNTIME_MIRROR_WRITER = new InjectionToken<ChatSessionRuntimeMirrorWriterPort>(
  'AILY_CHAT_SESSION_RUNTIME_MIRROR_WRITER',
);

export class ChatSessionRuntimeMirrorWriter implements ChatSessionRuntimeMirrorWriterPort {
  constructor(
    private readonly store: ChatSessionRuntimeMirrorStorePort,
  ) {}

  read(sessionId: string | null | undefined): ChatSessionRuntimeState | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId
      ? this.store.read(normalizedSessionId)
      : undefined;
  }

  hasSession(sessionId: string | null | undefined): boolean {
    return this.read(sessionId) !== undefined;
  }

  getSessionIds(): readonly string[] {
    return this.store.getSessionIds();
  }

  write(
    sessionId: string | null | undefined,
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    this.store.replaceRuntimeState(normalizedSessionId, state, options);
    return true;
  }

  clearSession(
    sessionId: string | null | undefined,
    options?: ChatSessionRuntimeChangeOptions,
  ): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    this.store.clearSession(normalizedSessionId, options);
    return true;
  }

  clearAll(): void {
    this.store.clearAll();
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }
}

@Injectable()
export class ChatSessionRuntimeStoreMirrorWriterService extends ChatSessionRuntimeMirrorWriter {
  constructor(runtimeStore: ChatSessionRuntimeStoreService) {
    super(runtimeStore);
  }
}

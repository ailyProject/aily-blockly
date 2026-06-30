import { Injectable } from '@angular/core';

import { MAIN_AGENT_TYPE } from '../core/agent-identifiers';
import type { ChatRuntimeOwnerStatePort } from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerStateService implements ChatRuntimeOwnerStatePort {
  private readonly runtimeSessionOwnerScopes: Array<{
    readonly token: symbol;
    readonly sessionId: string;
  }> = [];

  currentMessageSource = MAIN_AGENT_TYPE;
  toolCallingIteration = 0;
  isWaiting = false;
  isCompleted = false;
  isCancelled = false;
  activeToolExecutions = 0;
  currentStatelessMode = false;

  resetForCancellation(): void {
    this.isCompleted = false;
    this.isCancelled = true;
    this.activeToolExecutions = 0;
  }

  resolveActiveRuntimeSessionId(defaultSessionId?: string | null): string {
    const activeScope = this.runtimeSessionOwnerScopes[this.runtimeSessionOwnerScopes.length - 1];
    const scopedSessionId = this.normalizeSessionId(activeScope?.sessionId);
    if (scopedSessionId) {
      return scopedSessionId;
    }
    return this.normalizeSessionId(defaultSessionId);
  }

  async runWithRuntimeSessionOwner<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const release = this.beginRuntimeSessionOwnerScope(sessionId);
    try {
      return await action();
    } finally {
      release();
    }
  }

  beginRuntimeSessionOwnerScope(sessionId: string): () => void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      throw new Error('[AilyChat][RuntimeOwnerState] Runtime session owner scope requires a session id.');
    }

    const token = Symbol('runtime-session-owner');
    this.runtimeSessionOwnerScopes.push({ token, sessionId: normalizedSessionId });
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const index = this.runtimeSessionOwnerScopes.findIndex(scope => scope.token === token);
      if (index >= 0) {
        this.runtimeSessionOwnerScopes.splice(index, 1);
      }
    };
  }

  private normalizeSessionId(sessionId?: string | null): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }
}

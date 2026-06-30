import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

import {
  createElectronChatRuntimeHostTransport,
} from '../core/electron-chat-runtime-host-transport';
import type {
  ChatRuntimeHost,
  ChatRuntimeHostEvent,
  ChatRuntimeHostEventSubscription,
  ChatRuntimeHostSessionInventorySnapshot,
  ChatRuntimeHostSessionInventoryItem,
  ChatRuntimeHostSessionState,
} from '../core/chat-runtime-host-contract';

export interface ChatRuntimeHostInventoryChangedEvent {
  readonly sessionIds: readonly string[];
  readonly reason: 'initial' | 'host-snapshot' | 'host-event';
}

function emptyInventorySnapshot(): ChatRuntimeHostSessionInventorySnapshot {
  return {
    revision: 0,
    sessions: [],
  };
}

@Injectable()
export class ChatRuntimeHostInventoryService implements OnDestroy {
  private readonly host: ChatRuntimeHost | null = createElectronChatRuntimeHostTransport();
  private readonly changedSubject = new Subject<ChatRuntimeHostInventoryChangedEvent>();
  private readonly sessionStates = new Map<string, ChatRuntimeHostSessionInventoryItem>();
  private hostEvents: ChatRuntimeHostEventSubscription | null = null;
  private snapshot: ChatRuntimeHostSessionInventorySnapshot = emptyInventorySnapshot();
  private refreshGeneration = 0;

  readonly changed$ = this.changedSubject.asObservable();

  constructor() {
    if (!this.host) {
      return;
    }

    this.hostEvents = this.host.onEvent(event => this.handleHostEvent(event));
    void this.refreshFromHost('initial');
  }

  ngOnDestroy(): void {
    this.hostEvents?.dispose();
    this.hostEvents = null;
    this.changedSubject.complete();
  }

  readSnapshot(): ChatRuntimeHostSessionInventorySnapshot {
    return this.snapshot;
  }

  readSessionState(sessionId: string | null | undefined): ChatRuntimeHostSessionInventoryItem | null {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId ? this.sessionStates.get(normalizedSessionId) ?? null : null;
  }

  async refreshFromHost(reason: ChatRuntimeHostInventoryChangedEvent['reason'] = 'host-snapshot'): Promise<void> {
    if (!this.host) {
      return;
    }

    const generation = ++this.refreshGeneration;
    const snapshot = await this.host.readSessionInventory();
    if (generation !== this.refreshGeneration) {
      return;
    }
    this.applySnapshot(snapshot, reason);
  }

  private handleHostEvent(event: ChatRuntimeHostEvent): void {
    if (event.kind === 'session-state' || event.kind === 'runtime-status') {
      this.upsertSessionState(event.state, 'host-event');
    }
  }

  private applySnapshot(
    snapshot: ChatRuntimeHostSessionInventorySnapshot | null | undefined,
    reason: ChatRuntimeHostInventoryChangedEvent['reason'],
  ): void {
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    const nextStates = new Map<string, ChatRuntimeHostSessionInventoryItem>();
    for (const state of sessions) {
      const sessionId = this.normalizeSessionId(state?.sessionId);
      if (sessionId) {
        nextStates.set(sessionId, { ...state, sessionId });
      }
    }
    this.sessionStates.clear();
    for (const [sessionId, state] of nextStates) {
      this.sessionStates.set(sessionId, state);
    }
    this.snapshot = {
      revision: Number(snapshot?.revision) || 0,
      sessions: [...this.sessionStates.values()],
    };
    this.changedSubject.next({
      sessionIds: [...this.sessionStates.keys()],
      reason,
    });
  }

  private upsertSessionState(
    state: ChatRuntimeHostSessionInventoryItem | ChatRuntimeHostSessionState | null | undefined,
    reason: ChatRuntimeHostInventoryChangedEvent['reason'],
  ): void {
    const sessionId = this.normalizeSessionId(state?.sessionId);
    if (!sessionId || !state) {
      return;
    }

    const previous = this.sessionStates.get(sessionId);
    const next = { ...state, sessionId };
    if (previous && this.isSameSessionState(previous, next)) {
      return;
    }
    this.sessionStates.set(sessionId, next);
    this.snapshot = {
      revision: Math.max(this.snapshot.revision, Number(next.transcriptRevision) || 0),
      sessions: [...this.sessionStates.values()],
    };
    this.changedSubject.next({
      sessionIds: [sessionId],
      reason,
    });
  }

  private isSameSessionState(left: ChatRuntimeHostSessionInventoryItem, right: ChatRuntimeHostSessionInventoryItem): boolean {
    return left.sessionId === right.sessionId
      && left.status === right.status
      && left.requestInProgress === right.requestInProgress
      && (left.activeTurnId ?? null) === (right.activeTurnId ?? null)
      && left.transcriptRevision === right.transcriptRevision
      && this.isSameStringArray(left.attachedViewIds, right.attachedViewIds);
  }

  private isSameStringArray(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
    const leftValues = Array.isArray(left) ? left : [];
    const rightValues = Array.isArray(right) ? right : [];
    if (leftValues.length !== rightValues.length) {
      return false;
    }
    return leftValues.every((value, index) => value === rightValues[index]);
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : '';
  }
}

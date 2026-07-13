import type { ChatPendingRequestKind, PendingFollowupRequest } from './chat-pending-request';

export type ChatSessionActionActiveState = 'idle' | 'running' | 'stopping' | 'needsInput';
export type ChatSessionActionDraftState = 'empty' | 'hasDraft';

export interface ChatSessionActionState {
  readonly activeState: ChatSessionActionActiveState;
  readonly draftState: ChatSessionActionDraftState;
  readonly pendingCount: number;
  readonly steeringCount: number;
  readonly canSend: boolean;
  readonly canQueue: boolean;
  readonly canStop: boolean;
  readonly canSteer: boolean;
  readonly primaryIcon: 'send' | 'queue' | 'stop';
  readonly secondaryIcon: 'stop' | null;
  readonly tooltip: string;
}

export function createChatSessionActionState(
  overrides: Partial<ChatSessionActionState> = {},
): ChatSessionActionState {
  return {
    activeState: 'idle',
    draftState: 'empty',
    pendingCount: 0,
    steeringCount: 0,
    canSend: false,
    canQueue: false,
    canStop: false,
    canSteer: false,
    primaryIcon: 'send',
    secondaryIcon: null,
    tooltip: 'Send message',
    ...overrides,
  };
}

interface QueueOptionsLike {
  kind?: ChatPendingRequestKind;
}

export class ChatRequestController {
  constructor(
    private readonly deps: {
      sendNow: (text: string, sessionId?: string | null) => Promise<unknown>;
      queue: (text: string, sessionId?: string | null, options?: QueueOptionsLike) => Promise<boolean> | boolean;
      stop: (sessionId?: string | null) => boolean | Promise<boolean>;
      getPending: (sessionId?: string | null) => readonly PendingFollowupRequest[];
      hasPending: (sessionId?: string | null) => boolean;
      clearPending: (sessionId?: string | null) => void;
      removePending: (sessionId: string | null | undefined, requestId: string) => boolean;
      runNext: (sessionId: string | null | undefined, requestId: string) => Promise<boolean>;
      getActionState?: (sessionId?: string | null) => ChatSessionActionState;
      processPending?: (sessionId?: string | null) => Promise<boolean> | boolean;
    },
  ) {}

  async sendNow(text: string, sessionId?: string | null): Promise<unknown> {
    return typeof sessionId === 'undefined'
      ? this.deps.sendNow(text)
      : this.deps.sendNow(text, sessionId);
  }

  queue(text: string, sessionId?: string | null, options?: QueueOptionsLike): Promise<boolean> | boolean {
    return this.deps.queue(text, sessionId, options);
  }

  stop(sessionId?: string | null, _source?: string): boolean | Promise<boolean> {
    return this.deps.stop(sessionId);
  }

  getPending(sessionId?: string | null): readonly PendingFollowupRequest[] {
    return this.deps.getPending(sessionId);
  }

  hasPending(sessionId?: string | null): boolean {
    return this.deps.hasPending(sessionId);
  }

  clearPending(sessionId?: string | null): void {
    this.deps.clearPending(sessionId);
  }

  removePending(sessionId: string | null | undefined, requestId: string): boolean {
    return this.deps.removePending(sessionId, requestId);
  }

  runNext(sessionId: string | null | undefined, requestId: string): Promise<boolean> {
    return this.deps.runNext(sessionId, requestId);
  }

  getActionState(sessionId?: string | null): ChatSessionActionState {
    if (typeof this.deps.getActionState === 'function') {
      return this.deps.getActionState(sessionId);
    }

    const pendingRequests = this.getPending(sessionId);
    return createChatSessionActionState({
      pendingCount: pendingRequests.length,
      steeringCount: pendingRequests.filter(request => request.kind === 'steering').length,
      tooltip: 'Type a message to send',
    });
  }

  processPending(sessionId?: string | null): Promise<boolean> | boolean {
    if (typeof this.deps.processPending !== 'function') {
      return false;
    }

    return this.deps.processPending(sessionId);
  }
}

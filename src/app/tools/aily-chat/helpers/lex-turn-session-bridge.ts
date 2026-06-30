import type { ITurnDataSource, TurnSpan } from '../core/turn-data-source';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';

type LexSessionSnapshot = import('aily-lex/browser').SessionSnapshot;
type LexTurnRequestMetadata = import('aily-lex/browser').TurnRequest['metadata'];

interface LexApiMessage {
  role: string;
  content?: unknown;
  toolCalls?: readonly {
    id: string;
    name: string;
    arguments: unknown;
  }[];
  toolCallId?: unknown;
  name?: unknown;
}

interface LexApiMessageSpan {
  turnIndex: number;
  startMsgIdx: number;
  endMsgIdx: number;
}

interface LexTurnRoundAccess {
  id: string;
}

interface LexTurnAccess {
  id: string;
  index: number;
  request: {
    content: string;
    displayContent?: string;
    metadata?: LexTurnRequestMetadata;
  };
  rounds: readonly LexTurnRoundAccess[];
}

interface LexTurnManagerAccess {
  readonly revision: number;
  readonly activeTurn?: {
    readonly request: {
      readonly metadata?: LexTurnRequestMetadata;
    };
  };
  readonly turns: {
    get(): readonly LexTurnAccess[];
  };
  toAPIMessages(): readonly LexApiMessage[];
  toAPIMessagesWithSpans(): {
    readonly messages: readonly LexApiMessage[];
    readonly spans: readonly LexApiMessageSpan[];
  };
  startTurn(request: {
    content: string;
    displayContent?: string;
    metadata?: LexTurnRequestMetadata;
  }): { id: string };
  completeTurnText(response: string): void;
  failTurn(reason: string): void;
  removeIncomplete(): boolean;
  removeFrom(turnIndex: number): void;
  toSnapshot(): LexSessionSnapshot;
}

interface LexTurnSessionAgentAccess {
  readonly turnManager: LexTurnManagerAccess;
  saveSession?(): LexSessionSnapshot;
}

function isLexTurnSessionTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceLexTurnSession', [
    '__AILY_CHAT_TRACE_LEX_TURN_SESSION__',
    'AILY_CHAT_TRACE_LEX_TURN_SESSION',
  ]);
}

/**
 * Thin adapter over lex TurnManager / session APIs.
 *
 * Keeps LexOwnerFacade focused on stream/event bridging while this helper owns
 * OpenAI-shape conversion plus turn/session mutation helpers used by blockly.
 */
export class LexTurnSessionBridge implements ITurnDataSource {
  constructor(private readonly getAgent: () => LexTurnSessionAgentAccess | null) {}

  messages(): any[] {
    const agent = this.getAgent();
    if (!agent) return [];
    const msgs = agent.turnManager.toAPIMessages();
    return msgs.map(m => {
      const out: any = { role: m.role, content: m.content ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      if (m.toolCallId) out.tool_call_id = m.toolCallId;
      if (m.name) out.name = m.name;
      return out;
    });
  }

  messagesWithSpans(): { messages: any[]; turnSpans: TurnSpan[] } {
    const agent = this.getAgent();
    if (!agent) return { messages: [], turnSpans: [] };

    const { messages: lexMsgs, spans: lexSpans } = agent.turnManager.toAPIMessagesWithSpans();
    const messages = lexMsgs.map(m => {
      const out: any = { role: m.role, content: m.content ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      if (m.toolCallId) out.tool_call_id = m.toolCallId;
      if (m.name) out.name = m.name;
      return out;
    });

    const turns = agent.turnManager.turns.get();
    const turnSpans: TurnSpan[] = lexSpans.map(s => ({
      turnId: turns[s.turnIndex]?.id ?? `turn-${s.turnIndex}`,
      turnIndex: s.turnIndex,
      startIdx: s.startMsgIdx,
      endIdx: s.endMsgIdx,
      hasInfoTools: false,
    }));

    return { messages, turnSpans };
  }

  recordDirectTurn(request: string, response: string): void {
    const agent = this.getAgent();
    if (!agent) return;
    const tm = agent.turnManager;
    tm.startTurn({ content: request });
    tm.completeTurnText(response);
  }

  buildMessages(): any[] {
    return this.messages();
  }

  buildMessagesWithSpans(): { messages: any[]; turnSpans: TurnSpan[] } {
    return this.messagesWithSpans();
  }

  get revision(): number {
    return this.getAgent()?.turnManager.revision ?? 0;
  }

  getCurrentTurnId(): string | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const turns = agent.turnManager.turns.get();
    return turns[turns.length - 1]?.id;
  }

  getCurrentTurnIndex(): number | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const turns = agent.turnManager.turns.get();
    const index = turns[turns.length - 1]?.index;
    return typeof index === 'number' && Number.isFinite(index) ? index : undefined;
  }

  findTurnIdByRoundId(roundId: string): string | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const turns = agent.turnManager.turns.get();
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].rounds.some(round => round.id === roundId)) {
        return turns[index].id;
      }
    }
    return undefined;
  }

  getRequestContent(turnId: string): string | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const turns = agent.turnManager.turns.get();
    return turns.find(turn => turn.id === turnId)?.request.content;
  }

  getLastRoundId(turnId: string): string | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const turns = agent.turnManager.turns.get();
    return turns.find(turn => turn.id === turnId)?.rounds.at(-1)?.id;
  }

  getCurrentRequestMetadata(): LexTurnRequestMetadata {
    return this.getAgent()?.turnManager.activeTurn?.request.metadata;
  }

  startTurn(content: string, displayContent?: string, metadata?: LexTurnRequestMetadata): string | undefined {
    const agent = this.getAgent();
    if (!agent) return undefined;
    const persistedRequestContext = agent.saveSession?.().requestContext as unknown as LexTurnRequestMetadata | undefined;
    const effectiveMetadata = mergeResumedInteractionMetadata(
      agent.turnManager.activeTurn?.request.metadata ?? persistedRequestContext,
      metadata,
    );
    const turn = agent.turnManager.startTurn(
      {
        content,
        ...(typeof displayContent === 'string' ? { displayContent } : {}),
        ...(effectiveMetadata ? { metadata: effectiveMetadata } : {}),
      },
    );
    const activeMetadata = agent.turnManager.activeTurn?.request.metadata;
    const activeModelRouting = activeMetadata?.['modelRouting'];
    if (isLexTurnSessionTraceEnabled() && (effectiveMetadata?.['modelRouting'] || activeModelRouting)) {
      console.info('[LexTurnSession] startTurn request model routing:', {
        incomingModelRouting: metadata?.['modelRouting'],
        effectiveModelRouting: effectiveMetadata?.['modelRouting'],
        activeModelRouting,
      });
    }
    return turn.id;
  }

  completeTurn(response: string): void {
    const agent = this.getAgent();
    if (!agent) return;
    try {
      agent.turnManager.completeTurnText(response);
    } catch {
      // 如果没有 active turn（已被 lex 内部完成），忽略
    }
  }

  failTurn(): void {
    const agent = this.getAgent();
    if (!agent) return;
    try {
      agent.turnManager.failTurn('cancelled');
    } catch {
      // 没有 active turn 时忽略
    }
  }

  removeIncomplete(): boolean {
    return this.getAgent()?.turnManager.removeIncomplete() ?? false;
  }

  removeFromTurn(turnId: string): void {
    const agent = this.getAgent();
    if (!agent) return;
    const turns = agent.turnManager.turns.get();
    const turn = turns.find(t => t.id === turnId);
    if (turn) {
      agent.turnManager.removeFrom(turn.index);
    }
  }

  truncateToTurn(turnId: string): void {
    const agent = this.getAgent();
    if (!agent) return;
    const turns = agent.turnManager.turns.get();
    const turn = turns.find(t => t.id === turnId);
    if (turn) {
      const requestContent = turn.request.content;
      agent.turnManager.removeFrom(turn.index);
      agent.turnManager.startTurn(
        {
          content: requestContent,
          ...(typeof turn.request.displayContent === 'string' ? { displayContent: turn.request.displayContent } : {}),
          ...(turn.request.metadata ? { metadata: turn.request.metadata } : {}),
        },
      );
    }
  }

  clearTurns(): void {
    const agent = this.getAgent();
    if (!agent) return;
    agent.turnManager.removeFrom(0);
  }

  toSnapshot(): LexSessionSnapshot | null {
    return this.getAgent()?.turnManager.toSnapshot() ?? null;
  }
}

function mergeResumedInteractionMetadata(
  existing: LexTurnRequestMetadata | undefined,
  incoming: LexTurnRequestMetadata | undefined,
): LexTurnRequestMetadata | undefined {
  if (!incoming) {
    return incoming;
  }

  const existingContinuation = existing?.['interactionContinuation'];
  const incomingContinuation = incoming['interactionContinuation'];

  if (!existingContinuation || incomingContinuation || !shouldCarryExistingInteractionContinuation(existingContinuation)) {
    return incoming;
  }

  return {
    ...incoming,
    interactionContinuation: existingContinuation,
  };
}

function shouldCarryExistingInteractionContinuation(continuation: unknown): boolean {
  if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation)) {
    return false;
  }

  const record = continuation as Record<string, unknown>;
  const interactionId = typeof record['interactionId'] === 'string' ? record['interactionId'].trim() : '';
  const lease = typeof record['lease'] === 'string' ? record['lease'].trim() : '';
  const stepIndex = record['stepIndex'];
  if (!interactionId || !lease || typeof stepIndex !== 'number' || !Number.isFinite(stepIndex) || stepIndex < 0) {
    return false;
  }

  const pendingState = record['pendingState'];
  const pendingKind = pendingState && typeof pendingState === 'object' && !Array.isArray(pendingState)
    ? (pendingState as Record<string, unknown>)['kind']
    : undefined;
  if (typeof pendingKind === 'string' && pendingKind !== 'none') {
    return true;
  }

  const hardStopReason = typeof record['hardStopReason'] === 'string' ? record['hardStopReason'] : undefined;
  if (hardStopReason?.startsWith('interaction_')) {
    return false;
  }

  const stopReason = typeof record['stopReason'] === 'string' ? record['stopReason'] : undefined;
  if (stopReason === 'COMPLETED') {
    return false;
  }

  const status = typeof record['status'] === 'string' ? record['status'] : undefined;
  return status !== 'completed' && status !== 'complete';
}

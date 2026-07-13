import type { TurnResponseTurn } from 'aily-lex/browser';

export interface PendingTurnResponsePartSummary {
  readonly turnId: string | null;
  readonly partIndex: number;
  readonly type: string | null;
  readonly state: string | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
}

export interface PendingTurnResponseInteractionSummary {
  readonly hasPendingInteraction: boolean;
  readonly reasons: readonly string[];
  readonly pendingParts: readonly PendingTurnResponsePartSummary[];
  readonly latestTurnId: string | null;
}

export function hasPendingTurnResponseInteraction(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): boolean {
  return summarizePendingTurnResponseInteraction(turnResponses).hasPendingInteraction;
}

export function summarizePendingTurnResponseInteraction(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): PendingTurnResponseInteractionSummary {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return {
      hasPendingInteraction: false,
      reasons: [],
      pendingParts: [],
      latestTurnId: null,
    };
  }

  const reasons = new Set<string>();
  const pendingParts: PendingTurnResponsePartSummary[] = [];
  for (const turn of turnResponses) {
    const turnId = normalizeString((turn as unknown as Record<string, unknown>)?.['turnId']);
    const response = readRecord((turn as unknown as Record<string, unknown>)?.['response']);
    if (!response) {
      continue;
    }

    collectContinuationReasons(response['continuation'], reasons);

    const parts = Array.isArray(response['parts']) ? response['parts'] : [];
    parts.forEach((part, partIndex) => {
      const record = readRecord(part);
      if (!record) {
        return;
      }
      const type = normalizeString(record['type']);
      const state = normalizeString(record['state']);
      const toolName = normalizeString(record['toolName']);
      const toolCallId = normalizeString(record['toolCallId']) || normalizeString(record['id']);
      if (type === 'tool_call' && (state === 'doing' || state === 'pending_approval')) {
        reasons.add(state === 'pending_approval' ? 'tool_call_pending_approval' : 'tool_call_doing');
        pendingParts.push({
          turnId: turnId || null,
          partIndex,
          type: type || null,
          state: state || null,
          toolName: toolName || null,
          toolCallId: toolCallId || null,
        });
        return;
      }
      if ((type === 'confirmation' || type === 'question') && state !== 'done' && state !== 'cancelled' && state !== 'error') {
        reasons.add(`${type}_pending`);
        pendingParts.push({
          turnId: turnId || null,
          partIndex,
          type: type || null,
          state: state || null,
          toolName: toolName || null,
          toolCallId: toolCallId || null,
        });
      }
    });
  }

  const latestTurn = turnResponses[turnResponses.length - 1] as unknown as Record<string, unknown> | undefined;
  return {
    hasPendingInteraction: reasons.size > 0 || pendingParts.length > 0,
    reasons: [...reasons],
    pendingParts,
    latestTurnId: normalizeString(latestTurn?.['turnId']) || null,
  };
}

function collectContinuationReasons(continuation: unknown, reasons: Set<string>): void {
  const record = readRecord(continuation);
  if (!record) {
    return;
  }
  const stopReason = normalizeString(record['stopReason']);
  const status = normalizeString(record['status']);
  if (stopReason === 'TOOL_CALLS') {
    reasons.add('continuation_tool_calls');
  }
  if (status === 'waiting_tool_results') {
    reasons.add('continuation_waiting_tool_results');
  }
  if (status === 'waiting_confirmation') {
    reasons.add('continuation_waiting_confirmation');
  }
  if (status === 'waiting_question') {
    reasons.add('continuation_waiting_question');
  }
  const pendingState = readRecord(record['pendingState']);
  const pendingKind = normalizeString(pendingState?.['kind']);
  if (pendingKind === 'tool_results') {
    reasons.add('pending_state_tool_results');
  }
  if (pendingKind === 'confirmation') {
    reasons.add('pending_state_confirmation');
  }
  if (pendingKind === 'question') {
    reasons.add('pending_state_question');
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

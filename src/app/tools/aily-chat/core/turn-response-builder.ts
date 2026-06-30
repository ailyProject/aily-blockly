import type {
  RenderEvent,
  SessionSnapshot,
  TurnResponseTurn,
} from 'aily-lex/browser';
import {
  createTurnResponsePartsFromText,
  toTurnResponseStatus,
} from 'aily-lex/browser';

import { cloneTurnResponseModelRouting, getTurnResponseResolvedModelName } from '../helpers/turn-response-response-model';
import { TurnResponseIncrementalBuilder } from './turn-response-stream-builder';
import { buildTurnResponseTurn } from './turn-response-stream-contract';
import { MAIN_AGENT_TYPE } from './agent-identifiers';

/**
 * Build Copilot-style turn response containers from a lex snapshot + replayed render events.
 *
 * This is the first migration step away from `msgIndex + content string` as the
 * canonical host model. For now it is used in history restore, where both the
 * immutable turn snapshot and the flattened render narrative are available.
 */
export function buildTurnResponsesFromSessionHistory(
  snapshot: SessionSnapshot,
  events: readonly RenderEvent[],
  participant = MAIN_AGENT_TYPE,
): TurnResponseTurn[] {
  const turnsById = new Map(snapshot.turns.map(turn => [turn.id, turn]));
  const replayBuilder = new TurnResponseIncrementalBuilder();

  const turnResponses: TurnResponseTurn[] = [];

  const finalizeCurrentTurn = (
    updatedAt?: number,
    usage?: TurnResponseTurn['usage'],
    continuation?: TurnResponseTurn['response']['continuation'],
  ) => {
    const currentTurnId = replayBuilder.currentTurnId;
    if (!currentTurnId) {
      return;
    }

    const turn = turnsById.get(currentTurnId);
    const materialized = replayBuilder.materialize({
      updatedAt: updatedAt ?? turn?.createdAt ?? Date.now(),
      status: toTurnResponseStatus(turn?.status ?? 'completed'),
      usage,
      continuation,
      participant,
      snapshot: turn
        ? {
          request: turn.request,
          rounds: turn.rounds ?? [],
          usage: turn.usage,
          createdAt: turn.createdAt,
          terminationReason: turn.terminationReason,
          modelName: getTurnResponseResolvedModelName(turn),
          modelBillingLabel: turn.responseModel?.modelBillingLabel,
          modelRouting: cloneTurnResponseModelRouting(turn.responseModel?.modelRouting),
          quotaSnapshot: turn.responseModel?.quotaSnapshot,
        }
        : undefined,
    });

    if (materialized) {
      turnResponses.push(materialized);
    }

    replayBuilder.reset();
  };

  try {
    for (const event of events) {
      if (event.type === 'turn_begin') {
        finalizeCurrentTurn(event.timestamp);
        replayBuilder.beginTurn({
          turnId: event.turnId,
          request: turnsById.get(event.turnId)?.request ?? { content: '' },
          participant,
          timestamp: event.timestamp,
        });
        continue;
      }

      if (!replayBuilder.currentTurnId) {
        continue;
      }

      if (event.type === 'turn_end') {
        finalizeCurrentTurn(event.timestamp, event.usage, event.continuation);
        continue;
      }

      replayBuilder.processEvent(event);
    }

    finalizeCurrentTurn();
  } finally {
    replayBuilder.destroy();
  }

  return turnResponses;
}

export function buildTurnResponsesFromSessionSnapshot(
  snapshot: SessionSnapshot | null | undefined,
  participant = MAIN_AGENT_TYPE,
): TurnResponseTurn[] {
  if (!snapshot || !Array.isArray(snapshot.turns)) {
    return [];
  }

  return snapshot.turns
    .map(turn => {
      const persistedParts = Array.isArray(turn.response.parts) ? turn.response.parts : [];
      const responseParts = persistedParts.length > 0
        ? persistedParts
        : createTurnResponsePartsFromText(turn.response.resultText);
      const updatedAt = turn.response.updatedAt ?? turn.createdAt;
      return buildTurnResponseTurn({
        turnId: turn.id,
        request: turn.request,
        rounds: turn.rounds ?? [],
        usage: turn.usage,
        requestUsage: turn.responseModel?.requestUsage,
        participant: turn.response.participant || participant,
        slashCommand: turn.responseModel?.slashCommand,
        followups: turn.responseModel?.followups,
        modelName: getTurnResponseResolvedModelName(turn),
        modelBillingLabel: turn.responseModel?.modelBillingLabel,
        modelRouting: cloneTurnResponseModelRouting(turn.responseModel?.modelRouting),
        quotaSnapshot: turn.responseModel?.quotaSnapshot,
        usedContext: turn.response.usedContext,
        contentReferences: turn.response.contentReferences,
        codeCitations: turn.response.codeCitations,
        progressMessages: turn.response.progressMessages,
        status: toTurnResponseStatus(turn.status),
        terminationReason: turn.terminationReason,
        parts: responseParts,
        resultText: turn.response.resultText,
        createdAt: turn.createdAt,
        updatedAt,
      });
    })
    .sort((left, right) => left.createdAt - right.createdAt);
}

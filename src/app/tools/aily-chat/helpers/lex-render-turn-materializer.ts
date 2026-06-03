import type { IAgentLifecycle } from '../core/chat-context';
import type { SessionSnapshot, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import { toTurnResponseStatus } from 'aily-lex/browser';

import { TurnResponseIncrementalBuilder } from '../core/turn-response-stream-builder';
import { getTurnResponseParticipant } from '../core/turn-response-stream-contract';
import { cloneTurnResponseModelRouting, getTurnResponseResolvedModelName } from './turn-response-response-model';

function mergeMaterializedTurnRequest(
  snapshotRequest: TurnResponseTurn['request'],
  liveRequest: TurnResponseTurn['request'],
): TurnResponseTurn['request'] {
  const displayContent = snapshotRequest.displayContent ?? liveRequest.displayContent;
  const metadata = snapshotRequest.metadata ?? liveRequest.metadata;
  const attachments = snapshotRequest.attachments ?? liveRequest.attachments;

  return {
    ...snapshotRequest,
    ...(displayContent ? { displayContent } : {}),
    ...(metadata ? { metadata } : {}),
    ...(attachments
      ? {
        attachments: attachments.map(attachment => ({ ...attachment })),
      }
      : {}),
  };
}

type LexRenderTurnMaterializerContext = Pick<IAgentLifecycle, 'isCancelled' | 'currentMessageSource'>;

export class LexRenderTurnMaterializer {
  constructor(
    private readonly ctx: LexRenderTurnMaterializerContext,
    private readonly getSessionSnapshot?: () => SessionSnapshot | null,
  ) {}

  materializeCurrentTurn(
    streamBuilder: TurnResponseIncrementalBuilder,
    currentTurn: TurnResponseTurn,
    options: {
      updatedAt: number;
      fallbackStatus: TurnResponseStatus;
      hasExecutionError: boolean;
      usage?: TurnResponseTurn['usage'];
      continuation?: TurnResponseTurn['response']['continuation'];
      terminationReason?: TurnResponseTurn['response']['terminationReason'];
      modelName?: string;
      modelBillingLabel?: string;
      modelRouting?: NonNullable<TurnResponseTurn['responseModel']>['modelRouting'];
      quotaSnapshot?: TurnResponseTurn['responseModel']['quotaSnapshot'];
    },
  ): TurnResponseTurn | null {
    const snapshotTurnId = streamBuilder.currentSourceTurnId ?? currentTurn.turnId;
    const snapshotTurn = this.getSessionSnapshot?.()?.turns.find(turn => turn.id === snapshotTurnId);
    const status = this.resolveTurnStatus(
      snapshotTurn ? toTurnResponseStatus(snapshotTurn.status) : undefined,
      options.fallbackStatus,
      options.hasExecutionError,
    );

    return streamBuilder.materialize({
      updatedAt: options.updatedAt,
      status,
      usage: options.usage,
      continuation: options.continuation,
      terminationReason: options.terminationReason,
      modelName: options.modelName,
      modelBillingLabel: options.modelBillingLabel,
      modelRouting: options.modelRouting,
      quotaSnapshot: options.quotaSnapshot,
      participant: getTurnResponseParticipant(
        this.ctx.currentMessageSource || currentTurn.response.participant,
      ),
      snapshot: snapshotTurn
        ? {
          request: mergeMaterializedTurnRequest(snapshotTurn.request, currentTurn.request),
          rounds: snapshotTurn.rounds ?? [],
          usage: snapshotTurn.usage,
          createdAt: snapshotTurn.createdAt,
          terminationReason: snapshotTurn.terminationReason,
          modelName: getTurnResponseResolvedModelName(snapshotTurn),
          modelBillingLabel: snapshotTurn.responseModel?.modelBillingLabel,
          modelRouting: cloneTurnResponseModelRouting(snapshotTurn.responseModel?.modelRouting),
          quotaSnapshot: snapshotTurn.responseModel?.quotaSnapshot,
        }
        : undefined,
    });
  }

  private resolveTurnStatus(
    snapshotStatus: TurnResponseStatus | undefined,
    fallbackStatus: TurnResponseStatus,
    hasExecutionError: boolean,
  ): TurnResponseStatus {
    if (snapshotStatus) {
      return snapshotStatus;
    }

    if (this.ctx.isCancelled) {
      return 'cancelled';
    }

    if (hasExecutionError) {
      return 'error';
    }

    return fallbackStatus;
  }
}
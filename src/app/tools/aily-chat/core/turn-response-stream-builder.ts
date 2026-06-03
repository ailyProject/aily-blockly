import type { RenderEvent, TurnResponseCommand, TurnResponseFollowup, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import {
  type ChatPartStore,
} from './chat-part-store';
import {
  DetachedChatPartRuntime,
  type DetachedRuntimeProjectionTargetHandle,
} from './detached-chat-part-runtime';
import { cloneTurnResponseModelRouting } from '../helpers/turn-response-response-model';
import { buildTurnResponseTurn } from './turn-response-stream-contract';

type IncrementalTurnResponseProjectionTargetStore = Pick<
  ChatPartStore,
  'projectPartChangesFromHandle'
>;

type IncrementalTurnResponseRuntime = Pick<
  DetachedChatPartRuntime,
  | 'finalizeRunningParts'
  | 'reset'
  | 'process'
  | 'hydrateTurnResponseParts'
  | 'collectTurnResponseParts'
  | 'projectPendingPartsTo'
  | 'drainTurnResponsePartChanges'
  | 'destroy'
>;

interface TurnResponseIncrementalProjection {
  readonly turnId: string;
  readonly sourceTurnId: string;
  readonly request: TurnResponseTurn['request'];
  readonly rounds: TurnResponseTurn['rounds'];
  readonly usage?: TurnResponseTurn['usage'];
  readonly requestUsage?: NonNullable<TurnResponseTurn['responseModel']>['requestUsage'];
  readonly participant?: string;
  readonly slashCommand?: TurnResponseCommand;
  readonly followups?: readonly TurnResponseFollowup[];
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
  readonly modelRouting?: NonNullable<TurnResponseTurn['responseModel']>['modelRouting'];
  readonly quotaSnapshot?: TurnResponseTurn['responseModel']['quotaSnapshot'];
  readonly usedContext?: TurnResponseTurn['response']['usedContext'];
  readonly contentReferences?: readonly NonNullable<TurnResponseTurn['response']['contentReferences']>[number][];
  readonly codeCitations?: readonly NonNullable<TurnResponseTurn['response']['codeCitations']>[number][];
  readonly progressMessages?: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][];
  readonly continuation?: TurnResponseTurn['response']['continuation'];
  readonly createdAt: number;
}

export interface TurnResponseIncrementalBeginOptions {
  readonly turnId: string;
  readonly request: TurnResponseTurn['request'];
  readonly participant?: string;
  readonly slashCommand?: TurnResponseCommand;
  readonly timestamp: number;
}

export interface TurnResponseIncrementalRetargetOptions {
  readonly turnId: string;
  readonly request: TurnResponseTurn['request'];
  readonly participant?: string;
  readonly slashCommand?: TurnResponseCommand;
  readonly timestamp: number;
}

export interface TurnResponseIncrementalMaterializeOptions {
  readonly updatedAt: number;
  readonly status: TurnResponseStatus;
  readonly terminationReason?: TurnResponseTurn['response']['terminationReason'];
  readonly continuation?: TurnResponseTurn['response']['continuation'];
  readonly usage?: TurnResponseTurn['usage'];
  readonly participant?: string;
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
  readonly modelRouting?: NonNullable<TurnResponseTurn['responseModel']>['modelRouting'];
  readonly quotaSnapshot?: TurnResponseTurn['responseModel']['quotaSnapshot'];
  readonly snapshot?: {
    readonly request?: TurnResponseTurn['request'];
    readonly rounds?: TurnResponseTurn['rounds'];
    readonly usage?: TurnResponseTurn['usage'];
    readonly requestUsage?: NonNullable<TurnResponseTurn['responseModel']>['requestUsage'];
    readonly createdAt?: number;
    readonly continuation?: TurnResponseTurn['response']['continuation'];
    readonly terminationReason?: TurnResponseTurn['response']['terminationReason'];
    readonly modelName?: string;
    readonly modelBillingLabel?: string;
    readonly modelRouting?: NonNullable<TurnResponseTurn['responseModel']>['modelRouting'];
    readonly quotaSnapshot?: TurnResponseTurn['responseModel']['quotaSnapshot'];
  };
}

/**
 * Shared incremental RenderEvent -> TurnResponseTurn builder used by both
 * live host sync and replay restore paths.
 */
export class TurnResponseIncrementalBuilder {
  private readonly runtime: IncrementalTurnResponseRuntime = new DetachedChatPartRuntime();
  private currentProjection: TurnResponseIncrementalProjection | null = null;

  get currentTurnId(): string | null {
    return this.currentProjection?.turnId ?? null;
  }

  get currentSourceTurnId(): string | null {
    return this.currentProjection?.sourceTurnId ?? null;
  }

  beginTurn(options: TurnResponseIncrementalBeginOptions): TurnResponseTurn {
    this.runtime.reset();
    this.currentProjection = {
      turnId: options.turnId,
      sourceTurnId: options.turnId,
      request: options.request,
      rounds: [],
      participant: options.participant,
      slashCommand: options.slashCommand,
      createdAt: options.timestamp,
    };

    return this.materialize({
      updatedAt: options.timestamp,
      status: 'streaming',
      participant: options.participant,
    })!;
  }

  retargetCurrentTurn(options: TurnResponseIncrementalRetargetOptions): TurnResponseTurn | null {
    if (!this.currentProjection) {
      return null;
    }

    this.currentProjection = {
      ...this.currentProjection,
      sourceTurnId: options.turnId,
      request: options.request,
      participant: options.participant ?? this.currentProjection.participant,
      slashCommand: options.slashCommand ?? this.currentProjection.slashCommand,
    };

    return this.materialize({
      updatedAt: options.timestamp,
      status: 'streaming',
      participant: options.participant,
    });
  }

  processEvent(event: RenderEvent): boolean {
    if (this.applyResponseMetadataEvent(event)) {
      return true;
    }

    return this.runtime.process(event);
  }

  materialize(options: TurnResponseIncrementalMaterializeOptions): TurnResponseTurn | null {
    if (!this.currentProjection) {
      return null;
    }

    if (options.status !== 'streaming') {
      this.runtime.finalizeRunningParts();
    }

    const request = options.snapshot?.request ?? this.currentProjection.request;
    const rounds = options.snapshot?.rounds ?? this.currentProjection.rounds;
    const usage = options.usage ?? options.snapshot?.usage ?? this.currentProjection.usage;
    const requestUsage = options.snapshot?.requestUsage ?? this.currentProjection.requestUsage;
    const participant = options.participant ?? this.currentProjection.participant;
    const createdAt = options.snapshot?.createdAt
      ?? this.currentProjection.createdAt
      ?? options.updatedAt;

    this.currentProjection = {
      turnId: this.currentProjection.turnId,
      sourceTurnId: this.currentProjection.sourceTurnId,
      request,
      rounds,
      usage,
      requestUsage,
      participant,
      slashCommand: this.currentProjection.slashCommand,
      followups: this.currentProjection.followups
        ? [...this.currentProjection.followups]
        : undefined,
      modelName: options.modelName ?? options.snapshot?.modelName ?? this.currentProjection.modelName,
      modelBillingLabel: options.modelBillingLabel ?? options.snapshot?.modelBillingLabel ?? this.currentProjection.modelBillingLabel,
      modelRouting: cloneTurnResponseModelRouting(options.modelRouting)
        ?? cloneTurnResponseModelRouting(options.snapshot?.modelRouting)
        ?? cloneTurnResponseModelRouting(this.currentProjection.modelRouting),
      quotaSnapshot: options.quotaSnapshot ?? options.snapshot?.quotaSnapshot ?? this.currentProjection.quotaSnapshot,
      usedContext: this.currentProjection.usedContext,
      contentReferences: this.currentProjection.contentReferences
        ? [...this.currentProjection.contentReferences]
        : undefined,
      codeCitations: this.currentProjection.codeCitations
        ? [...this.currentProjection.codeCitations]
        : undefined,
      progressMessages: this.currentProjection.progressMessages
        ? [...this.currentProjection.progressMessages]
        : undefined,
      continuation: options.continuation ?? options.snapshot?.continuation ?? this.currentProjection.continuation,
      createdAt,
    };

    return buildTurnResponseTurn({
      turnId: this.currentProjection.turnId,
      request,
      rounds,
      usage,
      requestUsage,
      participant,
      slashCommand: this.currentProjection.slashCommand,
      followups: this.currentProjection.followups,
      modelName: this.currentProjection.modelName,
      modelBillingLabel: this.currentProjection.modelBillingLabel,
      modelRouting: this.currentProjection.modelRouting,
      quotaSnapshot: this.currentProjection.quotaSnapshot,
      usedContext: this.currentProjection.usedContext,
      contentReferences: this.currentProjection.contentReferences,
      codeCitations: this.currentProjection.codeCitations,
      progressMessages: this.currentProjection.progressMessages,
      continuation: this.currentProjection.continuation,
      status: options.status,
      terminationReason: options.terminationReason ?? options.snapshot?.terminationReason,
      parts: this.runtime.collectTurnResponseParts(),
      createdAt,
      updatedAt: options.updatedAt,
    });
  }

  projectPendingPartsTo(
    targetStore: IncrementalTurnResponseProjectionTargetStore,
    targetHandle: DetachedRuntimeProjectionTargetHandle | null,
  ): boolean {
    return this.runtime.projectPendingPartsTo(targetStore, targetHandle);
  }

  drainTurnResponsePartChanges(): Array<{
    partIndex: number;
    kind: 'add' | 'update' | 'append';
    part: TurnResponseTurn['response']['parts'][number];
  }> {
    return this.runtime.drainTurnResponsePartChanges();
  }

  reset(): void {
    this.currentProjection = null;
    this.runtime.reset();
  }

  hydrateTurn(turn: TurnResponseTurn): void {
    this.runtime.hydrateTurnResponseParts(turn.response.parts ?? []);
    this.currentProjection = {
      turnId: turn.turnId,
      sourceTurnId: turn.turnId,
      request: turn.request,
      rounds: turn.rounds ?? [],
      usage: turn.usage,
      requestUsage: turn.responseModel?.requestUsage,
      participant: turn.response.participant,
      slashCommand: turn.responseModel?.slashCommand,
      followups: turn.responseModel?.followups
        ?? (turn.response as { followups?: readonly TurnResponseFollowup[] } | undefined)?.followups,
      modelName: turn.responseModel?.modelName,
      modelBillingLabel: turn.responseModel?.modelBillingLabel,
      modelRouting: cloneTurnResponseModelRouting(turn.responseModel?.modelRouting),
      quotaSnapshot: turn.responseModel?.quotaSnapshot,
      usedContext: turn.response.usedContext,
      contentReferences: turn.response.contentReferences,
      codeCitations: turn.response.codeCitations,
      progressMessages: turn.response.progressMessages,
      continuation: turn.response.continuation,
      createdAt: turn.createdAt,
    };
  }

  destroy(): void {
    this.runtime.destroy();
  }

  private applyResponseMetadataEvent(event: RenderEvent): boolean {
    if (!this.currentProjection) {
      return false;
    }

    switch (event.type) {
      case 'response_command':
        this.currentProjection = {
          ...this.currentProjection,
          slashCommand: event.value,
        };
        return true;
      case 'response_reference':
        if (event.value.kind === 'usedContext') {
          this.currentProjection = {
            ...this.currentProjection,
            usedContext: event.value,
          };
          return true;
        }

        this.currentProjection = {
          ...this.currentProjection,
          contentReferences: [...(this.currentProjection.contentReferences ?? []), event.value],
        };
        return true;
      case 'response_code_citation':
        this.currentProjection = {
          ...this.currentProjection,
          codeCitations: [...(this.currentProjection.codeCitations ?? []), event.value],
        };
        return true;
      case 'response_progress_message':
        this.currentProjection = {
          ...this.currentProjection,
          progressMessages: [...(this.currentProjection.progressMessages ?? []), event.value],
        };
        return true;
      case 'response_followups':
        this.currentProjection = {
          ...this.currentProjection,
          followups: event.value ? [...event.value] : undefined,
        };
        return true;
      case 'usage':
        if (event.scope !== 'request') {
          return false;
        }

        this.currentProjection = {
          ...this.currentProjection,
          requestUsage: {
            promptTokens: event.usage.inputTokens,
            completionTokens: event.usage.outputTokens,
            ...(typeof event.usage.outputBuffer === 'number' ? { outputBuffer: event.usage.outputBuffer } : {}),
            ...(event.usage.promptTokenDetails?.length ? { promptTokenDetails: [...event.usage.promptTokenDetails] } : {}),
          },
        };
        return true;
      default:
        return false;
    }
  }
}
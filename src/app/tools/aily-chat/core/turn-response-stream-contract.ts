import type { TurnResponseCommand, TurnResponseFollowup, TurnResponseQuotaSnapshot, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import { collectTurnResponseText } from 'aily-lex/browser';
import {
  buildDialogTurnContext,
  type DialogTurnContext,
} from './user-turn-action-target';
import {
  MAIN_AGENT_TYPE,
  normalizeAgentIdentifier,
} from './agent-identifiers';
import { cloneTurnResponseModelRouting } from '../helpers/turn-response-response-model';
import {
  applyAutoDiscountToBillingLabel,
  isAutoPresetIdentifier,
  isDefaultAutoPresetIdentifier,
} from '../helpers/model-billing-label';

function formatResolvedPresetDisplayName(presetId: string | undefined): string | undefined {
  if (!presetId) {
    return undefined;
  }

  const trimmedPresetId = presetId.trim();
  if (!trimmedPresetId) {
    return undefined;
  }

  return trimmedPresetId
    .split('-')
    .filter(segment => !!segment)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('-');
}

export type TurnResponseHostMessageState = 'doing' | 'done';

export interface TurnResponseUserEntryProjection {
  readonly displayContent?: string;
  readonly requestContent?: string;
  readonly state: TurnResponseHostMessageState;
  readonly source?: string;
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
}

export interface TurnResponseAssistantEntryProjection {
  readonly content?: string;
  readonly state: TurnResponseHostMessageState;
  readonly source?: string;
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
}

export interface TurnResponseUserMessageProjection {
  readonly role: 'user';
  readonly content: string;
  readonly state: TurnResponseHostMessageState;
  readonly turnContext: DialogTurnContext;
  readonly source?: string;
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
}

export interface TurnResponseAssistantMessageProjection {
  readonly role: 'aily';
  readonly content: string;
  readonly state: TurnResponseHostMessageState;
  readonly turnContext: DialogTurnContext;
  readonly source?: string;
  readonly modelName?: string;
  readonly modelBillingLabel?: string;
}

export interface TurnResponseStreamProjection {
  readonly turnId: string;
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
  readonly quotaSnapshot?: TurnResponseQuotaSnapshot;
  readonly usedContext?: TurnResponseTurn['response']['usedContext'];
  readonly contentReferences?: TurnResponseTurn['response']['contentReferences'];
  readonly codeCitations?: TurnResponseTurn['response']['codeCitations'];
  readonly progressMessages?: TurnResponseTurn['response']['progressMessages'];
  readonly continuation?: TurnResponseTurn['response']['continuation'];
  readonly status: TurnResponseStatus;
  readonly terminationReason?: TurnResponseTurn['response']['terminationReason'];
  readonly parts: TurnResponseTurn['response']['parts'];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function toTurnResponseHostMessageState(
  status: TurnResponseStatus,
): TurnResponseHostMessageState {
  return status === 'streaming' ? 'doing' : 'done';
}

export function getTurnResponseParticipant(participant?: string): string {
  return normalizeAgentIdentifier(participant) || MAIN_AGENT_TYPE;
}

export function getTurnResponseDisplayContent(
  request: TurnResponseTurn['request'],
): string {
  if (typeof request.displayContent === 'string') {
    return request.displayContent;
  }

  return typeof request.content === 'string' ? request.content : '';
}

export function buildTurnResponseRequest(
  content: string,
  displayContent?: string,
  metadata?: TurnResponseTurn['request']['metadata'],
): TurnResponseTurn['request'] {
  return {
    content,
    ...(typeof displayContent === 'string' ? { displayContent } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function withTurnResponseDisplayContent(
  request: TurnResponseTurn['request'],
  displayContent?: string,
): TurnResponseTurn['request'] {
  if (typeof displayContent !== 'string') {
    return request;
  }

  return {
    ...request,
    displayContent,
  };
}

export function withTurnResponseUserEntryProjection(
  turn: TurnResponseTurn,
  overrides: Partial<TurnResponseUserEntryProjection> = {},
): TurnResponseTurn {
  const nextContent = typeof overrides.requestContent === 'string'
    ? overrides.requestContent
    : turn.request.content;
  const requestedDisplayContent = typeof overrides.displayContent === 'string'
    ? overrides.displayContent
    : turn.request.displayContent;
  const shouldKeepDisplayContent = typeof requestedDisplayContent === 'string'
    && (typeof turn.request.displayContent === 'string' || requestedDisplayContent !== nextContent);
  const nextDisplayContent = shouldKeepDisplayContent ? requestedDisplayContent : undefined;

  if (nextContent === turn.request.content && nextDisplayContent === turn.request.displayContent) {
    return turn;
  }

  if (typeof nextDisplayContent === 'string') {
    return {
      ...turn,
      request: {
        ...turn.request,
        content: nextContent,
        displayContent: nextDisplayContent,
      },
    };
  }

  const { displayContent: _displayContent, ...requestWithoutDisplayContent } = turn.request as TurnResponseTurn['request'] & { displayContent?: string };
  return {
    ...turn,
    request: {
      ...requestWithoutDisplayContent,
      content: nextContent,
    },
  };
}

export function buildTurnResponseUserEntryProjection(
  turn: TurnResponseTurn,
  overrides: Partial<TurnResponseUserEntryProjection> = {},
): TurnResponseUserEntryProjection {
  return {
    displayContent: overrides.displayContent ?? getTurnResponseDisplayContent(turn.request),
    requestContent: overrides.requestContent ?? turn.request.content,
    state: overrides.state ?? 'done',
    source: overrides.source,
    modelName: overrides.modelName,
    modelBillingLabel: overrides.modelBillingLabel,
  };
}

export function buildTurnResponseAssistantEntryProjection(
  turn: TurnResponseTurn,
  overrides: Partial<TurnResponseAssistantEntryProjection> = {},
): TurnResponseAssistantEntryProjection {
  const requestMetadata = turn.request.metadata;
  const requestModelDisplayName = typeof requestMetadata?.['modelDisplayName'] === 'string' && requestMetadata['modelDisplayName'].trim()
    ? requestMetadata['modelDisplayName'].trim()
    : undefined;
  const requestModelDisplayBillingLabel = typeof requestMetadata?.['modelDisplayBillingLabel'] === 'string' && requestMetadata['modelDisplayBillingLabel'].trim()
    ? requestMetadata['modelDisplayBillingLabel'].trim()
    : undefined;
  const responseModelName = typeof turn.responseModel?.modelName === 'string' && turn.responseModel.modelName.trim()
    ? turn.responseModel.modelName.trim()
    : undefined;
  const responseModelBillingLabel = typeof turn.responseModel?.modelBillingLabel === 'string' && turn.responseModel.modelBillingLabel.trim()
    ? turn.responseModel.modelBillingLabel.trim()
    : undefined;
  const responseModelSelectedPresetId = typeof turn.responseModel?.modelRouting?.selectedPresetId === 'string' && turn.responseModel.modelRouting.selectedPresetId.trim()
    ? turn.responseModel.modelRouting.selectedPresetId.trim()
    : undefined;
  const continuationResolvedModelName = getContinuationResolvedModelName(turn.response.continuation);
  const continuationModelBillingLabel = getContinuationModelBillingLabel(turn.response.continuation);
  const requestModelPresetId = typeof requestMetadata?.['modelPresetId'] === 'string' && requestMetadata['modelPresetId'].trim()
    ? requestMetadata['modelPresetId'].trim()
    : undefined;
  const resolvedPresetId = responseModelSelectedPresetId ?? requestModelPresetId;
  const routedPresetDisplayName = responseModelSelectedPresetId && responseModelSelectedPresetId !== requestModelPresetId
    ? formatResolvedPresetDisplayName(responseModelSelectedPresetId)
    : undefined;
  const modelName = overrides.modelName
    ?? routedPresetDisplayName
    ?? continuationResolvedModelName
    ?? responseModelName
    ?? requestModelDisplayName;
  const modelBillingLabel = overrides.modelBillingLabel
    ?? continuationModelBillingLabel
    ?? responseModelBillingLabel
    ?? requestModelDisplayBillingLabel;
  return {
    content: overrides.content ?? '',
    state: overrides.state ?? toTurnResponseHostMessageState(turn.response.status),
    source: overrides.source ?? getTurnResponseParticipant(turn.response.participant),
    modelName,
    modelBillingLabel: isDefaultAutoPresetIdentifier(requestModelPresetId)
      ? applyAutoDiscountToBillingLabel(modelBillingLabel)
      : modelBillingLabel,
  };
}

export function buildTurnResponseUserMessageProjection(
  turn: TurnResponseTurn,
  overrides: Partial<TurnResponseUserEntryProjection> = {},
): TurnResponseUserMessageProjection {
  const projection = buildTurnResponseUserEntryProjection(turn, overrides);
  const turnContext = buildDialogTurnContext({
    turnResponse: turn,
    requestContent: projection.requestContent,
    displayContent: projection.displayContent,
  });
  return {
    role: 'user',
    content: projection.displayContent ?? '',
    state: projection.state,
    turnContext: turnContext!,
    source: projection.source,
    modelName: projection.modelName,
    modelBillingLabel: projection.modelBillingLabel,
  };
}

export function buildTurnResponseAssistantMessageProjection(
  turn: TurnResponseTurn,
  overrides: Partial<TurnResponseAssistantEntryProjection> = {},
): TurnResponseAssistantMessageProjection {
  const projection = buildTurnResponseAssistantEntryProjection(turn, overrides);
  const content = overrides.content === undefined
    && projection.content === ''
    && turn.response.parts.length === 0
    ? getTurnResponseResponseText(turn.response)
    : (projection.content ?? '');
  const turnContext = buildDialogTurnContext({ turnResponse: turn });
  return {
    role: 'aily',
    content,
    state: projection.state,
    turnContext: turnContext!,
    source: projection.source,
    modelName: projection.modelName,
    modelBillingLabel: projection.modelBillingLabel,
  };
}

export function getTurnResponseAssistantText(
  turn: TurnResponseTurn,
): string {
  return getTurnResponseResponseText(turn.response);
}

export function getTurnResponseResponseText(
  response: Pick<TurnResponseTurn['response'], 'resultText' | 'parts'>,
): string {
  return response.resultText || collectTurnResponseText(response.parts) || '';
}

export function isCanonicalTurnResponseUserEntryProjection(
  turn: TurnResponseTurn,
  projection: Partial<TurnResponseUserEntryProjection>,
): boolean {
  const actual = buildTurnResponseUserEntryProjection(turn, projection);
  const canonical = buildTurnResponseUserEntryProjection(turn);
  return actual.displayContent === canonical.displayContent
    && actual.requestContent === canonical.requestContent
    && actual.state === canonical.state
    && actual.source === canonical.source
    && actual.modelName === canonical.modelName;
}

export function isCanonicalTurnResponseAssistantEntryProjection(
  turn: TurnResponseTurn,
  projection: Partial<TurnResponseAssistantEntryProjection>,
): boolean {
  const actual = buildTurnResponseAssistantEntryProjection(turn, projection);
  const canonical = buildTurnResponseAssistantEntryProjection(turn);
  return actual.content === canonical.content
    && actual.state === canonical.state
    && actual.source === canonical.source;
}

export function buildTurnResponseTurn(
  projection: TurnResponseStreamProjection,
): TurnResponseTurn {
  const participant = getTurnResponseParticipant(projection.participant);
  const contentReferences = projection.contentReferences ? [...projection.contentReferences] : [];
  const codeCitations = projection.codeCitations ? [...projection.codeCitations] : [];
  const progressMessages = projection.progressMessages ? [...projection.progressMessages] : [];
  const modelName = typeof projection.modelName === 'string' && projection.modelName.trim()
    ? projection.modelName.trim()
    : getContinuationResolvedModelName(projection.continuation);
  const modelBillingLabel = typeof projection.modelBillingLabel === 'string' && projection.modelBillingLabel.trim()
    ? projection.modelBillingLabel.trim()
    : undefined;
  const modelRouting = cloneTurnResponseModelRouting(projection.modelRouting);
  const requestUsage = projection.requestUsage ?? getContinuationRequestUsage(projection.continuation);
  const quotaSnapshot = projection.quotaSnapshot
    ? {
      ...projection.quotaSnapshot,
      ...(projection.quotaSnapshot.quotaSnapshots
        ? { quotaSnapshots: { ...projection.quotaSnapshot.quotaSnapshots } }
        : {}),
      ...(projection.quotaSnapshot.rateLimitSnapshots
        ? { rateLimitSnapshots: { ...projection.quotaSnapshot.rateLimitSnapshots } }
        : {}),
    }
    : undefined;

  return {
    turnId: projection.turnId,
    request: projection.request,
    rounds: projection.rounds,
    usage: projection.usage,
    response: {
      id: projection.turnId,
      participant,
      usedContext: projection.usedContext,
      contentReferences,
      codeCitations,
      progressMessages,
      continuation: projection.continuation,
      status: projection.status,
      terminationReason: projection.terminationReason,
      parts: projection.parts,
      resultText: collectTurnResponseText(projection.parts),
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
    },
    ...((projection.slashCommand !== undefined
      || projection.followups !== undefined
      || modelName !== undefined
      || modelBillingLabel !== undefined
      || quotaSnapshot !== undefined
      || requestUsage !== undefined)
      ? {
        responseModel: {
          ...(projection.slashCommand !== undefined ? { slashCommand: projection.slashCommand } : {}),
          ...(projection.followups !== undefined ? { followups: [...projection.followups] } : {}),
          ...(modelName !== undefined ? { modelName } : {}),
          ...(modelBillingLabel !== undefined ? { modelBillingLabel } : {}),
          ...(modelRouting !== undefined ? { modelRouting } : {}),
          ...(quotaSnapshot !== undefined ? { quotaSnapshot } : {}),
          ...(requestUsage !== undefined ? { requestUsage } : {}),
        },
      }
      : {}),
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
  };
}

function getContinuationResolvedModelName(
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): string | undefined {
  const diagnostics = continuation?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in diagnostics ? diagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const resolvedModel = 'resolvedModel' in usage ? usage['resolvedModel'] : undefined;
  return typeof resolvedModel === 'string' && resolvedModel.trim()
    ? resolvedModel.trim()
    : undefined;
}

function getContinuationModelBillingLabel(
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): string | undefined {
  const diagnostics = continuation?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in diagnostics ? diagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const modelBillingLabel = 'modelBillingLabel' in usage ? usage['modelBillingLabel'] : undefined;
  return typeof modelBillingLabel === 'string' && modelBillingLabel.trim()
    ? modelBillingLabel.trim()
    : undefined;
}

function getContinuationRequestUsage(
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): NonNullable<TurnResponseTurn['responseModel']>['requestUsage'] | undefined {
  const diagnostics = continuation?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in diagnostics ? diagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const promptTokens = 'promptTokens' in usage ? usage['promptTokens'] : undefined;
  const completionTokens = 'completionTokens' in usage ? usage['completionTokens'] : undefined;
  const outputBuffer = 'outputBuffer' in usage ? usage['outputBuffer'] : undefined;
  const promptTokenDetails = 'promptTokenDetails' in usage && Array.isArray(usage['promptTokenDetails'])
    ? usage['promptTokenDetails']
      .map(detail => {
        if (!detail || typeof detail !== 'object') {
          return undefined;
        }

        const category = typeof (detail as { category?: unknown }).category === 'string'
          ? (detail as { category: string }).category.trim()
          : '';
        const label = typeof (detail as { label?: unknown }).label === 'string'
          ? (detail as { label: string }).label.trim()
          : '';
        const percentageOfPrompt = typeof (detail as { percentageOfPrompt?: unknown }).percentageOfPrompt === 'number'
          && Number.isFinite((detail as { percentageOfPrompt: number }).percentageOfPrompt)
          && (detail as { percentageOfPrompt: number }).percentageOfPrompt >= 0
          ? (detail as { percentageOfPrompt: number }).percentageOfPrompt
          : undefined;

        if (!category || !label || percentageOfPrompt === undefined) {
          return undefined;
        }

        return { category, label, percentageOfPrompt };
      })
      .filter((detail): detail is NonNullable<NonNullable<TurnResponseTurn['responseModel']>['requestUsage']>['promptTokenDetails'][number] => !!detail)
    : undefined;
  return typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0
    && typeof completionTokens === 'number' && Number.isFinite(completionTokens) && completionTokens >= 0
    ? {
        promptTokens,
        completionTokens,
        ...(typeof outputBuffer === 'number' && Number.isFinite(outputBuffer) && outputBuffer > 0 ? { outputBuffer } : {}),
        ...(promptTokenDetails?.length ? { promptTokenDetails } : {}),
      }
    : undefined;
}
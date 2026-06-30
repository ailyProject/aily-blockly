import {
  readTurnRequestDebugArtifactContent,
  readTurnRequestDebugSectionsSnapshot,
  type TurnRequest,
  type TurnResponsePart,
} from 'aily-lex/browser';

import type { HostSessionRecord } from './chat-history.service';
import { resolveHostSessionInteractionActionSummary } from '../helpers/host-session-interaction-action';
import { readPendingPlanReview } from '../helpers/host-session-restore-bridge';
import { resolveHostSessionRequestRoutingSummary } from '../helpers/host-session-request-routing';
import { resolveHostSessionProviderOptions } from '../helpers/host-session-input-state';

type HostSessionDebugModelRouting = NonNullable<NonNullable<HostSessionRecord['turnResponses']>[number]['responseModel']>['modelRouting'];

export type HostSessionDebugEventKind =
  | 'toolCall'
  | 'modelTurn'
  | 'generic'
  | 'subagentInvocation'
  | 'userMessage'
  | 'agentResponse';

export type HostSessionDebugLogLevel = 'trace' | 'info' | 'warning' | 'error';

export interface HostSessionDebugMessageSection {
  readonly name: string;
  readonly content: string;
}

export type HostSessionDebugCacheMessageRole = 'user' | 'system' | 'tools';

export interface HostSessionDebugCacheInputMessage {
  readonly role: HostSessionDebugCacheMessageRole;
  readonly rawRole?: string;
  readonly label: string;
  readonly content: string;
  readonly charLength: number;
}

export interface HostSessionDebugRequestShapeInfo {
  readonly label: string;
  readonly description?: string;
  readonly isContinuation: boolean;
  readonly hasPreviousResponseId?: boolean;
  readonly inputItemTypes: readonly string[];
}

export interface HostSessionDebugCacheExplorerContent {
  readonly system?: string;
  readonly tools?: string;
  readonly inputMessages: readonly HostSessionDebugCacheInputMessage[];
  readonly requestShape: HostSessionDebugRequestShapeInfo;
  readonly requestOptions?: string;
}

export interface HostSessionDebugEventCommon {
  readonly id: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly ownerSessionId?: string;
  readonly turnId: string;
  readonly selectedModeId?: string;
  readonly requestModeId?: string;
  readonly eventSource?: string;
  readonly kind: HostSessionDebugEventKind;
  readonly created: number;
  readonly parentEventId?: string;
}

export interface HostSessionDebugToolCallEvent extends HostSessionDebugEventCommon {
  readonly kind: 'toolCall';
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input?: string;
  readonly output?: string;
  readonly result?: 'success' | 'error';
  readonly durationInMillis?: number;
}

export interface HostSessionDebugModelTurnEvent extends HostSessionDebugEventCommon {
  readonly kind: 'modelTurn';
  readonly model?: string;
  readonly requestName?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly totalTokens?: number;
  readonly durationInMillis?: number;
  readonly status?: string;
  readonly systemPromptFile?: string;
  readonly toolsFile?: string;
}

export interface HostSessionDebugGenericEvent extends HostSessionDebugEventCommon {
  readonly kind: 'generic';
  readonly name: string;
  readonly details?: string;
  readonly level: HostSessionDebugLogLevel;
  readonly category?: string;
}

export interface HostSessionDebugSubagentInvocationEvent extends HostSessionDebugEventCommon {
  readonly kind: 'subagentInvocation';
  readonly agentName: string;
  readonly description?: string;
  readonly status?: 'running' | 'completed' | 'failed';
  readonly durationInMillis?: number;
  readonly toolCallCount?: number;
  readonly modelTurnCount?: number;
}

export interface HostSessionDebugUserMessageEvent extends HostSessionDebugEventCommon {
  readonly kind: 'userMessage';
  readonly message: string;
  readonly sections: readonly HostSessionDebugMessageSection[];
}

export interface HostSessionDebugAgentResponseEvent extends HostSessionDebugEventCommon {
  readonly kind: 'agentResponse';
  readonly message: string;
  readonly sections: readonly HostSessionDebugMessageSection[];
}

export type HostSessionDebugEvent =
  | HostSessionDebugToolCallEvent
  | HostSessionDebugModelTurnEvent
  | HostSessionDebugGenericEvent
  | HostSessionDebugSubagentInvocationEvent
  | HostSessionDebugUserMessageEvent
  | HostSessionDebugAgentResponseEvent;

export interface HostSessionDebugEventSummary {
  readonly totalEvents: number;
  readonly errorCount: number;
  readonly userMessageCount: number;
  readonly agentResponseCount: number;
  readonly modelTurnCount: number;
  readonly toolCallCount: number;
  readonly genericCount: number;
  readonly subagentInvocationCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
}

export interface HostSessionDebugResolvedMessageContent {
  readonly kind: 'message';
  readonly type: 'user' | 'agent';
  readonly message: string;
  readonly sections: readonly HostSessionDebugMessageSection[];
}

export interface HostSessionDebugResolvedToolCallContent {
  readonly kind: 'toolCall';
  readonly toolName: string;
  readonly result?: 'success' | 'error';
  readonly durationInMillis?: number;
  readonly input?: string;
  readonly output?: string;
}

export interface HostSessionDebugResolvedModelTurnContent {
  readonly kind: 'modelTurn';
  readonly requestName: string;
  readonly model?: string;
  readonly status?: string;
  readonly durationInMillis?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly totalTokens?: number;
  readonly requestRouting?: string;
  readonly requestOptions?: string;
  readonly sections?: readonly HostSessionDebugMessageSection[];
}

export interface HostSessionDebugCustomizationLogEntry {
  readonly category: 'applying' | 'skipped' | 'referenced' | 'skill' | 'custom-agent' | 'hook';
  readonly name: string;
  readonly source?: string;
  readonly reference?: string;
  readonly reason?: string;
}

export interface HostSessionDebugResolvedCustomizationSummaryContent {
  readonly kind: 'customizationSummary';
  readonly resolutionLogs: readonly HostSessionDebugCustomizationLogEntry[];
  readonly counts: {
    readonly instructions: number;
    readonly skills: number;
    readonly agents: number;
    readonly hooks: number;
    readonly skipped: number;
  };
  readonly durationInMillis?: number;
  readonly hostId?: string;
  readonly modelFamily?: string;
  readonly capabilities?: readonly string[];
}

export interface HostSessionDebugResolvedTextContent {
  readonly kind: 'text';
  readonly text: string;
}

export type HostSessionDebugResolvedEventContent =
  | HostSessionDebugResolvedMessageContent
  | HostSessionDebugResolvedToolCallContent
  | HostSessionDebugResolvedModelTurnContent
  | HostSessionDebugResolvedCustomizationSummaryContent
  | HostSessionDebugResolvedTextContent;

interface HostSessionDebugArtifacts {
  readonly events: HostSessionDebugEvent[];
  readonly resolvedContentById: ReadonlyMap<string, HostSessionDebugResolvedEventContent>;
}

interface HostSessionDebugStructuredMessagePart {
  readonly type?: string;
  readonly content?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

type HostSessionDebugPersistedTurn = NonNullable<HostSessionRecord['turnResponses']>[number];

type HostSessionDebugEventSeed =
  | Omit<HostSessionDebugToolCallEvent, 'id'>
  | Omit<HostSessionDebugModelTurnEvent, 'id'>
  | Omit<HostSessionDebugGenericEvent, 'id'>
  | Omit<HostSessionDebugSubagentInvocationEvent, 'id'>
  | Omit<HostSessionDebugUserMessageEvent, 'id'>
  | Omit<HostSessionDebugAgentResponseEvent, 'id'>;

export function buildHostSessionDebugEvents(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
): HostSessionDebugEvent[] {
  return buildHostSessionDebugArtifacts(record).events;
}

export function resolveHostSessionDebugEventContent(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
  eventId: string,
  options?: {
    readonly events?: readonly HostSessionDebugEvent[];
    readonly readCompanionFile?: (fileName: string) => string | undefined;
    readonly readRequestArtifactContent?: (kind: 'system' | 'tools', turnId: string) => string | undefined;
  },
): HostSessionDebugResolvedEventContent | undefined {
  const content = buildHostSessionDebugArtifacts(record).resolvedContentById.get(eventId);
  if (!content || content.kind !== 'modelTurn') {
    return content;
  }

  const modelTurnEvent = options.events?.find(
    (event): event is HostSessionDebugModelTurnEvent => event.id === eventId && event.kind === 'modelTurn',
  );
  if (!modelTurnEvent) {
    return content;
  }

  const systemFromCompanion = modelTurnEvent.systemPromptFile && options.readCompanionFile
    ? options.readCompanionFile(modelTurnEvent.systemPromptFile)
    : undefined;
  const toolsFromCompanion = modelTurnEvent.toolsFile && options.readCompanionFile
    ? options.readCompanionFile(modelTurnEvent.toolsFile)
    : undefined;
  const systemFromRequestArtifact = options.readRequestArtifactContent?.('system', modelTurnEvent.turnId);
  const toolsFromRequestArtifact = options.readRequestArtifactContent?.('tools', modelTurnEvent.turnId);
  const systemContent = systemFromCompanion ?? systemFromRequestArtifact;
  const toolsContent = toolsFromCompanion ?? toolsFromRequestArtifact;
  if (!systemContent && !toolsContent) {
    return content;
  }

  return {
    ...content,
    sections: mergeModelTurnSections(content.sections ?? [], systemContent, toolsContent),
  };
}

export function createHostSessionDebugEventId(
  sessionId: string,
  turnId: string,
  kind: HostSessionDebugEventKind,
  sequence: number,
): string {
  return `${sessionId}:${turnId}:${kind}:${sequence}`;
}

export function buildHostSessionDebugEventSummary(
  events: readonly HostSessionDebugEvent[],
): HostSessionDebugEventSummary {
  const summary = {
    totalEvents: events.length,
    errorCount: 0,
    userMessageCount: 0,
    agentResponseCount: 0,
    modelTurnCount: 0,
    toolCallCount: 0,
    genericCount: 0,
    subagentInvocationCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
  };

  for (const event of events) {
    if (isHostSessionDebugErrorEvent(event)) {
      summary.errorCount += 1;
    }

    switch (event.kind) {
      case 'userMessage':
        summary.userMessageCount += 1;
        break;
      case 'agentResponse':
        summary.agentResponseCount += 1;
        break;
      case 'modelTurn':
        summary.modelTurnCount += 1;
        summary.totalInputTokens += event.inputTokens ?? 0;
        summary.totalOutputTokens += event.outputTokens ?? 0;
        summary.totalCachedTokens += event.cachedTokens ?? 0;
        break;
      case 'toolCall':
        summary.toolCallCount += 1;
        break;
      case 'generic':
        summary.genericCount += 1;
        break;
      case 'subagentInvocation':
        summary.subagentInvocationCount += 1;
        break;
    }
  }

  return summary;
}

export function getHostSessionDebugEventTitle(event: HostSessionDebugEvent): string {
  switch (event.kind) {
    case 'toolCall':
      return `Tool call: ${event.toolName}`;
    case 'modelTurn':
      return event.model ? `Model turn: ${event.model}` : 'Model turn';
    case 'generic':
      return event.category ? `${event.category}: ${event.name}` : event.name;
    case 'subagentInvocation':
      return `Subagent: ${event.agentName}`;
    case 'userMessage':
      return 'User message';
    case 'agentResponse':
      return 'Agent response';
  }
}

export function getHostSessionDebugEventDetails(event: HostSessionDebugEvent): string | undefined {
  switch (event.kind) {
    case 'toolCall':
      return [event.input, event.output].filter(Boolean).join(' · ') || undefined;
    case 'modelTurn':
      return [
        event.requestName,
        typeof event.totalTokens === 'number' ? `${event.totalTokens} tokens` : '',
        typeof event.durationInMillis === 'number' ? `${event.durationInMillis}ms` : '',
      ].filter(Boolean).join(' · ') || undefined;
    case 'generic':
      return event.details;
    case 'subagentInvocation':
      return [event.description, event.status].filter(Boolean).join(' · ') || undefined;
    case 'userMessage':
    case 'agentResponse':
      return previewText(event.message, 180);
  }
}

export function isHostSessionDebugErrorEvent(event: HostSessionDebugEvent): boolean {
  return (event.kind === 'toolCall' && event.result === 'error')
    || (event.kind === 'modelTurn' && event.status === 'error')
    || (event.kind === 'generic' && event.level === 'error')
    || (event.kind === 'subagentInvocation' && event.status === 'failed');
}

function buildHostSessionDebugArtifacts(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
): HostSessionDebugArtifacts {
  const sessionId = typeof record.metadata?.sessionId === 'string' ? record.metadata.sessionId : '';
  const events: HostSessionDebugEvent[] = [];
  const resolvedContentById = new Map<string, HostSessionDebugResolvedEventContent>();
  let sequence = 0;
  const sessionEventTurnId = (record.turnResponses?.[record.turnResponses.length - 1]?.turnId ?? '__session__').trim() || '__session__';
  const sessionEventCreated = normalizeTimestamp(record.metadata?.updatedAt, record.metadata?.createdAt);
  const requestRouting = resolveHostSessionRequestRoutingSummary(record);
  const providerOptions = resolveHostSessionProviderOptions(record);
  const interactionActionSummary = resolveHostSessionInteractionActionSummary(record);
  const pendingPlanReview = readPendingPlanReview(record.metadata?.requestContext?.interactionContinuation);

  if (providerOptions.folderPath || providerOptions.permissionMode !== 'default' || providerOptions.permissionLevel || providerOptions.approvalsReviewer || providerOptions.approvalPolicy) {
    const event = createDebugEvent({
      sessionId,
      ownerSessionId: sessionId,
      turnId: sessionEventTurnId,
      sequence: sequence++,
      kind: 'generic',
      created: sessionEventCreated,
      name: 'Session Provider Options',
      details: formatProviderOptionsDetails(providerOptions),
      level: 'info',
      category: 'session',
      eventSource: 'session',
      selectedModeId: requestRouting.selectedModeId,
      ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
    });
    events.push(event);
    resolvedContentById.set(event.id, {
      kind: 'text',
      text: JSON.stringify(providerOptions, null, 2),
    });
  }

  if (requestRouting.requestModeId || requestRouting.customAgentTarget || requestRouting.permissionLevel || requestRouting.approvalsReviewer || requestRouting.approvalPolicy) {
    const event = createDebugEvent({
      sessionId,
      ownerSessionId: sessionId,
      turnId: sessionEventTurnId,
      sequence: sequence++,
      kind: 'generic',
      created: sessionEventCreated,
      name: 'Request Routing',
      details: formatRequestRoutingDetails(requestRouting),
      level: 'info',
      category: 'session',
      eventSource: 'session',
      selectedModeId: requestRouting.selectedModeId,
      ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
    });
    events.push(event);
    resolvedContentById.set(event.id, {
      kind: 'text',
      text: JSON.stringify(requestRouting, null, 2),
    });
  }

  if (interactionActionSummary) {
    const event = createDebugEvent({
      sessionId,
      ownerSessionId: sessionId,
      turnId: sessionEventTurnId,
      sequence: sequence++,
      kind: 'generic',
      created: sessionEventCreated,
      name: 'Interaction Action',
      details: formatInteractionActionDetails(interactionActionSummary),
      level: 'info',
      category: 'session',
      eventSource: 'session',
      selectedModeId: requestRouting.selectedModeId,
      ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
    });
    events.push(event);
    resolvedContentById.set(event.id, {
      kind: 'text',
      text: JSON.stringify(interactionActionSummary, null, 2),
    });
  }

  if (pendingPlanReview) {
    const payload = {
      id: pendingPlanReview.id,
      title: pendingPlanReview.title,
      ...(pendingPlanReview.planUri ? { planUri: pendingPlanReview.planUri } : {}),
      canProvideFeedback: pendingPlanReview.canProvideFeedback,
      actions: pendingPlanReview.actions.map(action => action.id),
    };
    const event = createDebugEvent({
      sessionId,
      ownerSessionId: sessionId,
      turnId: sessionEventTurnId,
      sequence: sequence++,
      kind: 'generic',
      created: sessionEventCreated,
      name: 'Pending Plan Review',
      details: formatPendingPlanReviewDetails(payload),
      level: 'info',
      category: 'session',
      eventSource: 'session',
      selectedModeId: requestRouting.selectedModeId,
      ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
    });
    events.push(event);
    resolvedContentById.set(event.id, {
      kind: 'text',
      text: JSON.stringify(payload, null, 2),
    });
  }

  for (const turn of record.turnResponses ?? []) {
    const turnRequestRouting = resolveHostSessionRequestRoutingSummary({
      metadata: record.metadata,
      turnResponses: [turn],
    });
    const turnDebugBoundary = buildDebugEventBoundaryFields(sessionId, turnRequestRouting);
    const userMessageSections = buildMessageSections('request', turn.request.displayContent ?? turn.request.content);
    const requestContent = extractRequestContent(turn.request);
    let userMessageEventId: string | undefined;
    if (requestContent) {
      const event = createDebugEvent({
        ...turnDebugBoundary,
        sessionId,
        turnId: turn.turnId,
        sequence: sequence++,
        kind: 'userMessage',
        created: normalizeTimestamp(turn.createdAt, turn.updatedAt),
        message: requestContent,
        sections: userMessageSections,
        eventSource: 'turn-request',
      });
      userMessageEventId = event.id;
      events.push(event);
      resolvedContentById.set(event.id, {
        kind: 'message',
        type: 'user',
        message: requestContent,
        sections: userMessageSections,
      });
    }

    const modelTurnCreated = normalizeTimestamp(
      turn.response.timestamp,
      turn.response.updatedAt,
      turn.response.createdAt,
      turn.updatedAt,
    );
    const modelTurnDuration = typeof turn.response.elapsedMs === 'number'
      ? turn.response.elapsedMs
      : deriveDuration(turn.response.createdAt, turn.response.updatedAt);
    const modelTurnTotalTokens = sumNumbers(turn.usage?.inputTokens, turn.usage?.outputTokens);
    const modelTurnEvent = createDebugEvent({
      ...turnDebugBoundary,
      sessionId,
      turnId: turn.turnId,
      sequence: sequence++,
      kind: 'modelTurn',
      created: modelTurnCreated,
      parentEventId: userMessageEventId,
      model: record.metadata?.model ?? undefined,
      requestName: previewText(requestContent, 60),
      inputTokens: turn.usage?.inputTokens,
      outputTokens: turn.usage?.outputTokens,
      cachedTokens: turn.usage?.cacheReadTokens,
      totalTokens: modelTurnTotalTokens,
      durationInMillis: modelTurnDuration,
      status: turn.response.status,
      eventSource: 'model-turn',
    });
    events.push(modelTurnEvent);

    const modelRouting = turn.responseModel?.modelRouting;
    if (modelRouting) {
      const event = createDebugEvent({
        ...turnDebugBoundary,
        sessionId,
        turnId: turn.turnId,
        sequence: sequence++,
        kind: 'generic',
        created: modelTurnCreated,
        parentEventId: modelTurnEvent.id,
        name: 'Auto model routing',
        details: formatModelRoutingDetails(modelRouting),
        level: 'info',
        category: 'model',
        eventSource: 'model-routing',
      });
      events.push(event);
      resolvedContentById.set(event.id, {
        kind: 'text',
        text: JSON.stringify(modelRouting, null, 2),
      });
    }

    for (const round of turn.rounds ?? []) {
      for (const toolCall of round.toolCalls ?? []) {
        const input = safeJsonSummary(toolCall.input) || undefined;
        const output = safeUnknownSummary(toolCall.output) || toolCall.error?.trim() || undefined;
        const event = createDebugEvent({
          ...turnDebugBoundary,
          sessionId,
          turnId: turn.turnId,
          sequence: sequence++,
          kind: 'toolCall',
          created: normalizeTimestamp(round.timestamp, modelTurnCreated, turn.updatedAt),
          parentEventId: modelTurnEvent.id,
          toolName: toolCall.toolName || toolCall.id,
          toolCallId: toolCall.id,
          input,
          output,
          result: toolCall.error ? 'error' : 'success',
          durationInMillis: toolCall.durationMs,
          eventSource: 'tool-round',
        });
        events.push(event);
        resolvedContentById.set(event.id, {
          kind: 'toolCall',
          toolName: event.toolName,
          result: event.result,
          durationInMillis: event.durationInMillis,
          input: event.input,
          output: event.output,
        });
      }
    }

    const requestSections = buildModelTurnRequestSections(turn.request);
    const responseParts = resolvePersistedTurnResponseParts(turn);
    const responseSections = buildResponseSections(responseParts, turn.response.resultText);
    const modelTurnSections = [...requestSections, ...responseSections];
    for (const progressMessage of turn.response.progressMessages ?? []) {
      events.push(createDebugEvent({
        ...turnDebugBoundary,
        sessionId,
        turnId: turn.turnId,
        sequence: sequence++,
        kind: 'generic',
        created: modelTurnCreated,
        parentEventId: modelTurnEvent.id,
        name: 'Progress',
        details: progressMessage.content,
        level: 'info',
        category: 'progress',
        eventSource: 'progress',
      }));
    }

    for (const part of responseParts) {
      const projected = projectPartEvent(part, {
        sessionId,
        turnId: turn.turnId,
        modelTurnEventId: modelTurnEvent.id,
        created: modelTurnCreated,
        sequence: sequence++,
        toolCallParentId: findToolCallParentEventId(events, modelTurnEvent.id, part),
        boundary: turnDebugBoundary,
      });
      if (!projected) {
        continue;
      }

      events.push(projected.event);
      if (projected.content) {
        resolvedContentById.set(projected.event.id, projected.content);
      }
    }

    resolvedContentById.set(modelTurnEvent.id, {
      kind: 'modelTurn',
      requestName: modelTurnEvent.requestName || 'Model turn',
      model: modelTurnEvent.model,
      status: modelTurnEvent.status,
      durationInMillis: modelTurnEvent.durationInMillis,
      inputTokens: modelTurnEvent.inputTokens,
      outputTokens: modelTurnEvent.outputTokens,
      cachedTokens: modelTurnEvent.cachedTokens,
      totalTokens: modelTurnEvent.totalTokens,
      requestRouting: JSON.stringify(turnRequestRouting, null, 2),
      requestOptions: modelTurnSections.find(section => section.name === 'Request Options')?.content,
      sections: modelTurnSections,
    });

    const agentResponseEvent = createDebugEvent({
      ...turnDebugBoundary,
      sessionId,
      turnId: turn.turnId,
      sequence: sequence++,
      kind: 'agentResponse',
      created: modelTurnCreated,
      parentEventId: modelTurnEvent.id,
      message: turn.response.resultText,
      sections: responseSections,
      eventSource: 'agent-response',
    });
    events.push(agentResponseEvent);
    resolvedContentById.set(agentResponseEvent.id, {
      kind: 'message',
      type: 'agent',
      message: agentResponseEvent.message,
      sections: responseSections,
    });
  }

  return { events, resolvedContentById };
}

function createDebugEvent<TEvent extends HostSessionDebugEventSeed>(
  event: TEvent,
): TEvent & Pick<HostSessionDebugEventCommon, 'id' | 'ownerSessionId'> {
  return {
    ...event,
    ownerSessionId: event.ownerSessionId ?? event.sessionId,
    id: createHostSessionDebugEventId(event.sessionId, event.turnId, event.kind, event.sequence),
  };
}

function buildDebugEventBoundaryFields(
  sessionId: string,
  requestRouting: ReturnType<typeof resolveHostSessionRequestRoutingSummary>,
): Pick<HostSessionDebugEventCommon, 'ownerSessionId' | 'selectedModeId' | 'requestModeId'> {
  return {
    ownerSessionId: sessionId,
    selectedModeId: requestRouting.selectedModeId,
    ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
  };
}

function extractRequestContent(request: TurnRequest): string {
  const displayContent = typeof request.displayContent === 'string' ? request.displayContent.trim() : '';
  if (displayContent) {
    return displayContent;
  }

  return typeof request.content === 'string' ? request.content.trim() : '';
}

function normalizeTimestamp(...candidates: Array<number | null | undefined>): number {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

function safeJsonSummary(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  try {
    const text = JSON.stringify(value);
    return previewText(text, 180) ?? '';
  } catch {
    return '';
  }
}

function safeUnknownSummary(value: unknown): string {
  if (typeof value === 'string') {
    return previewText(value, 180) ?? '';
  }

  return safeJsonSummary(value);
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const normalized = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!normalized.length) {
    return undefined;
  }

  return normalized.reduce((sum, value) => sum + value, 0);
}

function deriveDuration(start: number | undefined, end: number | undefined): number | undefined {
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }

  return Math.max(0, end - start);
}

function formatRequestRoutingDetails(
  requestRouting: ReturnType<typeof resolveHostSessionRequestRoutingSummary>,
): string {
  return [
    `selected=${requestRouting.selectedModeId}`,
    requestRouting.requestModeId ? `request=${requestRouting.requestModeId}` : '',
    requestRouting.customAgentTarget ? `customAgent=${requestRouting.customAgentTarget}` : '',
    requestRouting.permissionLevel ? `permission=${requestRouting.permissionLevel}` : '',
    requestRouting.approvalsReviewer ? `reviewer=${requestRouting.approvalsReviewer}` : '',
    requestRouting.approvalPolicy ? `approvalPolicy=${requestRouting.approvalPolicy}` : '',
  ].filter(Boolean).join(', ');
}

function formatModelRoutingDetails(modelRouting: HostSessionDebugModelRouting): string {
  return [
    modelRouting.requestedModel ? `requestedModel: ${modelRouting.requestedModel}` : '',
    modelRouting.requestedPresetId ? `requestedPresetId: ${modelRouting.requestedPresetId}` : '',
    modelRouting.selectedModel ? `selectedModel: ${modelRouting.selectedModel}` : '',
    modelRouting.selectedPresetId ? `selectedPresetId: ${modelRouting.selectedPresetId}` : '',
    modelRouting.selectedFamily ? `selectedFamily: ${modelRouting.selectedFamily}` : '',
    modelRouting.routingMethod ? `routingMethod: ${modelRouting.routingMethod}` : '',
    modelRouting.predictedLabel ? `predictedLabel: ${modelRouting.predictedLabel}` : '',
    typeof modelRouting.confidence === 'number' ? `confidence: ${modelRouting.confidence}` : '',
    typeof modelRouting.latencyMs === 'number' ? `latencyMs: ${modelRouting.latencyMs}` : '',
    typeof modelRouting.candidateCount === 'number' ? `candidateCount: ${modelRouting.candidateCount}` : '',
    Array.isArray(modelRouting.candidateModels) && modelRouting.candidateModels.length > 0
      ? `candidateModels: ${modelRouting.candidateModels.join(', ')}`
      : '',
    typeof modelRouting.fallback === 'boolean' ? `fallback: ${modelRouting.fallback ? 'yes' : 'no'}` : '',
    modelRouting.fallbackReason ? `fallbackReason: ${modelRouting.fallbackReason}` : '',
    typeof modelRouting.stickyOverride === 'boolean' ? `stickyOverride: ${modelRouting.stickyOverride ? 'yes' : 'no'}` : '',
    modelRouting.policyVersion ? `policyVersion: ${modelRouting.policyVersion}` : '',
    modelRouting.modelBillingLabel ? `modelBillingLabel: ${modelRouting.modelBillingLabel}` : '',
  ].filter(Boolean).join('\n');
}

function formatProviderOptionsDetails(
  providerOptions: ReturnType<typeof resolveHostSessionProviderOptions>,
): string {
  return [
    providerOptions.folderPath ? `folder=${providerOptions.folderPath}` : '',
    `permissionMode=${providerOptions.permissionMode}`,
    providerOptions.permissionLevel ? `permissionLevel=${providerOptions.permissionLevel}` : '',
    providerOptions.approvalsReviewer ? `approvalsReviewer=${providerOptions.approvalsReviewer}` : '',
    providerOptions.approvalPolicy ? `approvalPolicy=${providerOptions.approvalPolicy}` : '',
  ].filter(Boolean).join(', ');
}

function formatInteractionActionDetails(
  interactionActionSummary: NonNullable<ReturnType<typeof resolveHostSessionInteractionActionSummary>>,
): string {
  return [
    `kind=${interactionActionSummary.kind}`,
    interactionActionSummary.result ? `result=${interactionActionSummary.result}` : '',
    interactionActionSummary.actionId ? `action=${interactionActionSummary.actionId}` : '',
    interactionActionSummary.sourceEvent ? `source=${interactionActionSummary.sourceEvent}` : '',
  ].filter(Boolean).join(', ');
}

function formatPendingPlanReviewDetails(review: {
  title: string;
  planUri?: string;
  canProvideFeedback: boolean;
  actions: readonly string[];
}): string {
  return [
    `title=${review.title}`,
    review.planUri ? `plan=${review.planUri}` : '',
    `feedback=${review.canProvideFeedback ? 'enabled' : 'disabled'}`,
    review.actions.length > 0 ? `actions=${review.actions.join('|')}` : '',
  ].filter(Boolean).join(', ');
}

function buildMessageSections(name: string, content: string | undefined): HostSessionDebugMessageSection[] {
  const text = typeof content === 'string' ? content.trim() : '';
  return text ? [{ name, content: text }] : [];
}

function buildResponseSections(
  parts: readonly TurnResponsePart[],
  resultText: string,
): HostSessionDebugMessageSection[] {
  const sections: HostSessionDebugMessageSection[] = [];
  const outputMessages = buildOutputMessagesSection(parts, resultText);
  if (outputMessages) {
    sections.push({ name: 'Output Messages', content: outputMessages });
  }

  const responseText = previewText(resultText, 4000);
  if (responseText) {
    sections.push({ name: 'response', content: responseText });
  }

  const toolSections = parts
    .filter((part): part is Extract<TurnResponsePart, { type: 'tool_call' }> => part.type === 'tool_call')
    .map(part => ({ name: `tool:${part.toolName}`, content: previewText(part.text, 400) ?? part.toolName }));

  const genericSections = parts
    .filter(part => part.type === 'thinking' || part.type === 'info' || part.type === 'warning' || part.type === 'error')
    .map((part, index) => {
      switch (part.type) {
        case 'thinking':
          return { name: `thinking:${index + 1}`, content: previewText(part.content, 400) ?? '' };
        case 'info':
        case 'warning':
        case 'error':
          return { name: `${part.type}:${index + 1}`, content: previewText(part.message, 400) ?? '' };
        default:
          return null;
      }
    })
    .filter((section): section is HostSessionDebugMessageSection => Boolean(section?.content));

  return [...sections, ...toolSections, ...genericSections];
}

function buildModelTurnRequestSections(request: TurnRequest): HostSessionDebugMessageSection[] {
  return (readTurnRequestDebugSectionsSnapshot(request.metadata) ?? [])
    .filter(section => section.name !== 'System' && section.name !== 'Tools')
    .map(section => ({
      name: section.name,
      content: section.content,
    }));
}

function mergeModelTurnSections(
  sections: readonly HostSessionDebugMessageSection[],
  systemContent: string | undefined,
  toolsContent: string | undefined,
): HostSessionDebugMessageSection[] {
  const existingInputMessages = sections.find(section => section.name === 'Input Messages');
  const existingRequestShape = sections.find(section => section.name === 'Request Shape');
  const existingRequestOptions = sections.find(section => section.name === 'Request Options');
  const remainingSections = sections.filter(section => ![
    'Input Messages',
    'Request Shape',
    'Request Options',
  ].includes(section.name));

  return [
    ...(systemContent
      ? [{ name: 'System', content: systemContent }]
      : []),
    ...(existingInputMessages ? [existingInputMessages] : []),
    ...(existingRequestShape ? [existingRequestShape] : []),
    ...(existingRequestOptions ? [existingRequestOptions] : []),
    ...(toolsContent
      ? [{ name: 'Tools', content: toolsContent }]
      : []),
    ...remainingSections,
  ];
}

function buildOutputMessagesSection(
  parts: readonly TurnResponsePart[],
  resultText: string,
): string | undefined {
  const assistantParts: HostSessionDebugStructuredMessagePart[] = [];
  const responseText = typeof resultText === 'string' ? resultText.trim() : '';
  if (responseText) {
    assistantParts.push({ type: 'text', content: responseText });
  }

  for (const part of parts) {
    switch (part.type) {
      case 'tool_call':
        assistantParts.push({
          type: 'tool_call',
          name: part.toolName,
          ...(part.args !== undefined ? { arguments: part.args } : {}),
        });
        break;
      case 'thinking':
        if (part.content.trim()) {
          assistantParts.push({ type: 'reasoning', content: part.content });
        }
        break;
      case 'info':
      case 'warning':
      case 'error':
        if (part.message.trim()) {
          assistantParts.push({ type: 'text', content: part.message });
        }
        break;
      default:
        break;
    }
  }

  if (assistantParts.length === 0) {
    return undefined;
  }

  return jsonStringify([{
    role: 'assistant',
    parts: assistantParts,
  }]);
}

function resolvePersistedTurnResponseParts(
  turn: NonNullable<HostSessionRecord['turnResponses']>[number],
): readonly TurnResponsePart[] {
  const parts = Array.isArray(turn.response?.parts) ? [...turn.response.parts] : [];
  const envelopePlanPart = turn.planPart as TurnResponsePart | undefined;
  if (!envelopePlanPart || envelopePlanPart.type !== 'plan') {
    return parts;
  }

  const envelopePartId = typeof envelopePlanPart.partId === 'string' ? envelopePlanPart.partId.trim() : '';
  const hasSamePlanPart = parts.some((part) => {
    if (part.type !== 'plan') {
      return false;
    }
    const partId = typeof part.partId === 'string' ? part.partId.trim() : '';
    return envelopePartId
      ? partId === envelopePartId
      : part.text === envelopePlanPart.text && part.status === envelopePlanPart.status;
  });

  return hasSamePlanPart ? parts : [...parts, envelopePlanPart];
}

function jsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function findToolCallParentEventId(
  events: readonly HostSessionDebugEvent[],
  modelTurnEventId: string,
  part: TurnResponsePart,
): string {
  const toolCallId = 'toolCallId' in part && typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
  if (!toolCallId) {
    return modelTurnEventId;
  }

  const toolCallEvent = [...events].reverse().find((event) => {
    return event.kind === 'toolCall' && event.toolCallId === toolCallId;
  });
  return toolCallEvent?.id ?? modelTurnEventId;
}

function previewText(value: string | undefined, maxLength = 140): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return undefined;
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInstructionSkipReason(diagnostic: Record<string, unknown>): string | undefined {
  const skipReason = diagnostic['skipReason'];
  switch (skipReason) {
    case 'inactive':
      return 'inactive';
    case 'empty':
      return 'empty';
    case 'not_found':
      return 'missing';
    case 'overridden': {
      const overriddenById = typeof diagnostic['overriddenById'] === 'string'
        ? diagnostic['overriddenById'].trim()
        : '';
      return overriddenById ? `overridden by ${overriddenById}` : 'overridden';
    }
    default:
      return undefined;
  }
}

function buildInstructionCustomizationLogs(
  snapshot: Record<string, unknown>,
): HostSessionDebugCustomizationLogEntry[] {
  const diagnostics = Array.isArray(snapshot['diagnostics'])
    ? snapshot['diagnostics'].filter(isRecord)
    : [];

  return diagnostics.map((diagnostic) => {
    const name = formatInstructionCustomizationName(diagnostic);
    const source = typeof diagnostic['source'] === 'string' && diagnostic['source'].trim().length > 0
      ? diagnostic['source'].trim()
      : undefined;
    const reference = typeof diagnostic['reference'] === 'string' && diagnostic['reference'].trim().length > 0
      ? diagnostic['reference'].trim()
      : undefined;
    const reason = normalizeInstructionSkipReason(diagnostic);

    return {
      category: diagnostic['active'] === true ? 'applying' : 'skipped',
      name,
      ...(source ? { source } : {}),
      ...(reference ? { reference } : {}),
      ...(reason ? { reason } : {}),
    } satisfies HostSessionDebugCustomizationLogEntry;
  });
}

function formatInstructionCustomizationName(diagnostic: Record<string, unknown>): string {
  const displayPath = typeof diagnostic['displayPath'] === 'string' ? diagnostic['displayPath'].trim() : '';
  if (displayPath) {
    return `指令文件 ${displayPath}`;
  }

  const reference = typeof diagnostic['reference'] === 'string' ? diagnostic['reference'].trim() : '';
  const referenceLabel = formatInstructionCustomizationReference(reference);
  if (referenceLabel) {
    return `指令文件 ${referenceLabel}`;
  }

  const name = typeof diagnostic['name'] === 'string' ? diagnostic['name'].trim() : '';
  return name ? `指令文件 ${name}` : '指令文件 unknown';
}

function formatInstructionCustomizationReference(reference: string): string | undefined {
  if (!reference) {
    return undefined;
  }

  const normalized = reference.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) {
    return undefined;
  }

  const parent = segments.at(-2);
  return parent === '.aily' ? `${parent}/${fileName}` : fileName;
}

function buildInstructionCustomizationContent(
  part: Extract<TurnResponsePart, { type: 'state' }>,
): HostSessionDebugResolvedCustomizationSummaryContent | HostSessionDebugResolvedTextContent {
  const snapshot = isRecord(part.metadata?.['snapshot']) ? part.metadata['snapshot'] : undefined;
  if (!snapshot) {
    return {
      kind: 'text',
      text: (typeof part.text === 'string' ? part.text.trim() : '') || 'No customization details captured.',
    };
  }

  const hostId = typeof snapshot['hostId'] === 'string' ? snapshot['hostId'].trim() : '';
  const modelFamily = typeof snapshot['modelFamily'] === 'string' ? snapshot['modelFamily'].trim() : '';
  const capabilities = Array.isArray(snapshot['capabilities'])
    ? snapshot['capabilities'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const resolutionLogs = buildInstructionCustomizationLogs(snapshot);
  return {
    kind: 'customizationSummary',
    resolutionLogs,
    counts: {
      instructions: resolutionLogs.filter((entry) => entry.category === 'applying' || entry.category === 'referenced').length,
      skills: resolutionLogs.filter((entry) => entry.category === 'skill').length,
      agents: resolutionLogs.filter((entry) => entry.category === 'custom-agent').length,
      hooks: resolutionLogs.filter((entry) => entry.category === 'hook').length,
      skipped: resolutionLogs.filter((entry) => entry.category === 'skipped').length,
    },
    ...(hostId ? { hostId } : {}),
    ...(modelFamily ? { modelFamily } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };
}

function projectPartEvent(
  part: TurnResponsePart,
  context: {
    sessionId: string;
    turnId: string;
    modelTurnEventId: string;
    toolCallParentId: string;
    created: number;
    sequence: number;
    boundary: Pick<HostSessionDebugEventCommon, 'ownerSessionId' | 'selectedModeId' | 'requestModeId'>;
  },
): {
  event: HostSessionDebugEvent;
  content?: HostSessionDebugResolvedEventContent;
} | null {
  switch (part.type) {
    case 'state':
      if (part.kind === 'instructions') {
        return {
          event: createDebugEvent({
            ...context.boundary,
            sessionId: context.sessionId,
            turnId: context.turnId,
            sequence: context.sequence,
            kind: 'generic',
            created: context.created,
            parentEventId: context.modelTurnEventId,
            name: 'Resolve Customizations',
            details: previewText(part.text, 180),
            level: part.state === 'error' ? 'error' : (part.state === 'warn' ? 'warning' : 'info'),
            category: 'customization',
            eventSource: 'response-part',
          }),
          content: buildInstructionCustomizationContent(part),
        };
      }

      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: `State: ${part.kind ?? 'state'}`,
          details: [part.state, previewText(part.text, 180)].filter(Boolean).join(' · ') || undefined,
          level: part.state === 'error' ? 'error' : 'info',
          category: 'state',
          eventSource: 'response-part',
        }),
      };
    case 'question':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Question',
          details: previewText(part.questions.map(question => question.question).join(' · '), 180),
          level: 'info',
          category: 'question',
          eventSource: 'response-part',
        }),
      };
    case 'confirmation':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Confirmation',
          details: previewText([
            typeof part.title === 'string' ? part.title : '',
            typeof part.message === 'string' ? part.message : '',
            typeof part.result === 'string' ? part.result : '',
          ].filter(Boolean).join(' · '), 180),
          level: part.resolved === false ? 'error' : 'info',
          category: 'confirmation',
          eventSource: 'response-part',
        }),
      };
    case 'subagent':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'subagentInvocation',
          created: context.created,
          parentEventId: context.toolCallParentId,
          agentName: part.agentName,
          description: previewText([part.description, part.resultText].filter(Boolean).join(' · '), 240),
          status: part.state === 'doing' ? 'running' : (part.state === 'error' ? 'failed' : 'completed'),
          durationInMillis: sumChildItemDurations(part),
          toolCallCount: part.childItems?.filter(item => item.kind === 'tool').length,
          modelTurnCount: part.childItems?.filter(item => item.kind === 'text').length,
          eventSource: 'response-part',
        }),
        content: {
          kind: 'text',
          text: previewText([part.description, part.resultText].filter(Boolean).join('\n\n'), 4000) ?? part.agentName,
        },
      };
    case 'tool_call': {
      const autoReviewProjection = projectAutoReviewEvent(part, context);
      if (autoReviewProjection) {
        return autoReviewProjection;
      }
      return null;
    }
    case 'terminal':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.toolCallParentId,
          name: 'Terminal',
          details: previewText([
            typeof part.command === 'string' ? part.command : '',
            typeof part.exitCode === 'number' ? `exit ${part.exitCode}` : (part.isRunning ? 'running' : ''),
            typeof part.stderr === 'string' ? part.stderr : '',
          ].filter(Boolean).join(' · '), 180),
          level: typeof part.exitCode === 'number' && part.exitCode !== 0 ? 'error' : 'info',
          category: 'terminal',
          eventSource: 'response-part',
        }),
        content: {
          kind: 'text',
          text: [part.command, part.output, part.stderr].filter(Boolean).join('\n'),
        },
      };
    case 'plan':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Plan',
          details: previewText([
            part.status,
            part.source ? `source=${part.source}` : '',
            part.partId ? `part=${part.partId}` : '',
            part.text,
          ].filter(Boolean).join(' | '), 180),
          level: part.status === 'failed' ? 'error' : 'info',
          category: 'plan',
          eventSource: 'response-part',
        }),
        content: {
          kind: 'text',
          text: JSON.stringify({
            status: part.status,
            ...(part.source ? { source: part.source } : {}),
            ...(part.partId ? { partId: part.partId } : {}),
            charLength: typeof part.text === 'string' ? part.text.length : 0,
            text: part.text,
            ...(part.steps ? { steps: part.steps } : {}),
            ...(part.assumptions ? { assumptions: part.assumptions } : {}),
            ...(part.verification ? { verification: part.verification } : {}),
          }, null, 2),
        },
      };
    case 'info':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Info',
          details: previewText(part.message, 180),
          level: 'info',
          category: 'info',
          eventSource: 'response-part',
        }),
      };
    case 'warning':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Warning',
          details: previewText(part.message, 180),
          level: 'warning',
          category: 'warning',
          eventSource: 'response-part',
        }),
      };
    case 'error':
      return {
        event: createDebugEvent({
          ...context.boundary,
          sessionId: context.sessionId,
          turnId: context.turnId,
          sequence: context.sequence,
          kind: 'generic',
          created: context.created,
          parentEventId: context.modelTurnEventId,
          name: 'Error',
          details: previewText(part.message, 180),
          level: 'error',
          category: 'error',
          eventSource: 'response-part',
        }),
      };
    default:
      return null;
  }
}

function sumChildItemDurations(part: Extract<TurnResponsePart, { type: 'subagent' }>): number | undefined {
  const durations = part.childItems
    ?.map(item => item.duration)
    .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
  if (!durations?.length) {
    return undefined;
  }

  return durations.reduce((sum, duration) => sum + duration, 0);
}

function projectAutoReviewEvent(
  part: Extract<TurnResponsePart, { type: 'tool_call' }>,
  context: {
    sessionId: string;
    turnId: string;
    modelTurnEventId: string;
    toolCallParentId: string;
    created: number;
    sequence: number;
    boundary: Pick<HostSessionDebugEventCommon, 'ownerSessionId' | 'selectedModeId' | 'requestModeId'>;
  },
): {
  event: HostSessionDebugEvent;
  content?: HostSessionDebugResolvedEventContent;
} | null {
  const approval = readAutoReviewApprovalMetadata(part.metadata);
  if (!approval) {
    return null;
  }

  const startedAt = typeof approval['reviewStartedAt'] === 'number' ? approval['reviewStartedAt'] : undefined;
  const completedAt = typeof approval['reviewCompletedAt'] === 'number' ? approval['reviewCompletedAt'] : undefined;
  const created = completedAt ?? startedAt ?? context.created;
  const durationInMillis = typeof startedAt === 'number' && typeof completedAt === 'number'
    ? Math.max(0, completedAt - startedAt)
    : undefined;
  const status = typeof approval['reviewStatus'] === 'string' ? approval['reviewStatus'] : 'reviewing';
  const riskLevel = typeof approval['reviewRiskLevel'] === 'string' ? approval['reviewRiskLevel'] : undefined;
  const source = typeof approval['source'] === 'string' ? approval['source'] : undefined;
  const message = typeof approval['message'] === 'string' ? approval['message'] : undefined;
  const decisionSource = typeof approval['decisionSource'] === 'string' ? approval['decisionSource'] : undefined;
  const eventName = status === 'reviewing' ? 'Auto Review' : 'Auto Review Result';
  const details = [
    `tool=${part.toolName}`,
    `status=${status}`,
    riskLevel ? `risk=${riskLevel}` : '',
    source ? `source=${source}` : '',
    typeof durationInMillis === 'number' ? `duration=${durationInMillis}ms` : '',
  ].filter(Boolean).join(', ');
  const payload = {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    status,
    ...(riskLevel ? { riskLevel } : {}),
    ...(source ? { source } : {}),
    ...(decisionSource ? { decisionSource } : {}),
    ...(message ? { rationale: message } : {}),
    ...(typeof startedAt === 'number' ? { reviewStartedAt: startedAt } : {}),
    ...(typeof completedAt === 'number' ? { reviewCompletedAt: completedAt } : {}),
    ...(typeof durationInMillis === 'number' ? { durationInMillis } : {}),
  };

  return {
    event: createDebugEvent({
      ...context.boundary,
      sessionId: context.sessionId,
      turnId: context.turnId,
      sequence: context.sequence,
      kind: 'generic',
      created,
      parentEventId: context.toolCallParentId || context.modelTurnEventId,
      name: eventName,
      details,
      level: status === 'approved' || status === 'reviewing' ? 'info' : (status === 'timedOut' ? 'warning' : 'error'),
      category: 'approval',
      eventSource: 'response-part',
    }),
    content: {
      kind: 'text',
      text: JSON.stringify(payload, null, 2),
    },
  };
}

function readAutoReviewApprovalMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const root = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : null;
  const approval = root && typeof root['approval'] === 'object' && !Array.isArray(root['approval'])
    ? root['approval'] as Record<string, unknown>
    : null;
  if (!approval || approval['reviewer'] !== 'auto_review') {
    return null;
  }

  const status = approval['reviewStatus'];
  if (status !== 'reviewing' && status !== 'approved' && status !== 'denied' && status !== 'timedOut' && status !== 'aborted') {
    return null;
  }

  return approval;
}

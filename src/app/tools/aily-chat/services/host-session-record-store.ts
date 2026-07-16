import { AilyHost } from '../core/host';
import {
  normalizeChatSessionType,
  normalizeChatSelectedMode,
} from '../core/chat-mode';
import {
  normalizeChatSessionTitleText,
  normalizePersistedChatSessionTitleSource,
  type PersistedChatSessionTitleSource,
} from '../core/chat-session-title';
import type { TurnResponseFollowup, TurnResponseTurn } from 'aily-lex/browser';
import {
  hasHostSessionExplicitTurnRequestRouting,
  normalizeHostSessionRequestRoutingSummary,
  resolveHostSessionRequestRoutingSummary,
  resolveHostSessionTurnRequestRoutingSummary,
} from '../helpers/host-session-request-routing';
import {
  normalizeHostSessionInteractionActionSummary,
  resolveHostSessionInteractionActionSummary,
} from '../helpers/host-session-interaction-action';
import type { PlanPart } from '../core/chat-parts';
import {
  type HostSessionSelectedModeResolveOptions,
  normalizeHostSessionInputStateFromMetadata,
  resolveHostSessionModeDescriptor,
  resolveHostSessionModeDescriptorFromMetadata,
  resolveHostSessionInputState,
  resolveHostSessionSummaryModeFromMetadata,
  resolveHostSessionSelectedMode,
  resolveHostSessionSelectedModeFromMetadata,
} from '../helpers/host-session-input-state';
import {
  cloneHostSessionRuntimeAuxiliary,
  stripLegacyRuntimeAuxiliaryFromMetadata,
} from '../helpers/host-session-runtime-auxiliary';
import {
  normalizeHostSessionTurnRuntimeTruth,
  readHostSessionTurnRuntimeTruthFromMetadata,
} from '../helpers/host-session-runtime-truth';
import {
  readChatAgentRuntimeModeFromMetadata,
  readChatAgentRuntimeModeSourceFromMetadata,
} from '../core/chat-agent-runtime-mode';
import {
  HOST_SESSION_OPERATION_LOG_COMPACT_AFTER_BYTES,
  HostSessionOperationLog,
} from './host-session-operation-log';
import { ChatPerformanceTracer } from './chat-perf-tracer';

import type {
  HostSessionRecord,
  HostSessionCheckpointTimelineEntrySidecar,
  HostSessionRuntimeAuxiliary,
  HostSessionSidecar,
  PersistedHostResponseData,
  PersistedHostTurnResponse,
  SessionMetadata,
} from './chat-history.service';

function cloneContinuationBudgets(
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): Record<string, unknown> | undefined {
  const budgets = (continuation as (TurnResponseTurn['response']['continuation'] & {
    budgets?: Record<string, unknown>;
  }) | undefined)?.budgets;

  return budgets && typeof budgets === 'object'
    ? { ...budgets }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clonePersistedValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => clonePersistedValue(item)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, clonePersistedValue(entryValue)]),
    ) as T;
  }

  return value;
}

function cloneContinuationDiagnostics(
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): Record<string, unknown> | undefined {
  const diagnostics = (continuation as (TurnResponseTurn['response']['continuation'] & {
    diagnostics?: Record<string, unknown>;
  }) | undefined)?.diagnostics;

  if (!isRecord(diagnostics)) {
    return undefined;
  }

  const identity = isRecord(diagnostics['identity']) ? { ...diagnostics['identity'] } : undefined;
  const trace = isRecord(diagnostics['trace']) ? { ...diagnostics['trace'] } : undefined;
  const usage = isRecord(diagnostics['usage']) ? { ...diagnostics['usage'] } : undefined;
  const runtime = isRecord(diagnostics['runtime']) ? { ...diagnostics['runtime'] } : undefined;
  const budget = isRecord(diagnostics['budget']) ? { ...diagnostics['budget'] } : undefined;
  const outcome = isRecord(diagnostics['outcome']) ? { ...diagnostics['outcome'] } : undefined;
  const behavior = isRecord(diagnostics['behavior']) ? { ...diagnostics['behavior'] } : undefined;

  return {
    ...(identity ? { identity } : {}),
    ...(trace ? { trace } : {}),
    ...(usage ? { usage } : {}),
    ...(runtime ? { runtime } : {}),
    ...(budget ? { budget } : {}),
    ...(outcome ? { outcome } : {}),
    ...(behavior ? { behavior } : {}),
  };
}

function normalizeRoundSummary(summary: unknown): string | undefined {
  return typeof summary === 'string' && summary.trim()
    ? summary.trim()
    : undefined;
}

function deriveDefaultTitleFromTurnResponses(turnResponses: readonly PersistedHostTurnResponse[] | undefined): string {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return '';
  }

  for (const turnResponse of turnResponses) {
    const request = (turnResponse as { request?: unknown })?.request;
    const title = deriveDefaultTitleFromRequest(request);
    if (title) {
      return title;
    }
  }

  return '';
}

function deriveDefaultTitleFromRequest(request: unknown): string {
  const direct = readRequestTextCandidate(request);
  if (direct) {
    return direct;
  }

  if (request && typeof request === 'object') {
    const nested = readRequestTextCandidate((request as { message?: unknown }).message);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function readRequestTextCandidate(candidate: unknown): string {
  const text = typeof candidate === 'string'
    ? candidate
    : candidate && typeof candidate === 'object'
      ? ((candidate as { messageText?: unknown }).messageText
        ?? (candidate as { prompt?: unknown }).prompt
        ?? (candidate as { text?: unknown }).text
        ?? (candidate as { content?: unknown }).content)
      : undefined;

  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  return normalized.split('\n')[0]?.trim().substring(0, 200) ?? '';
}

function normalizePersistedSessionTitleMetadata(
  metadata: SessionMetadata,
  turnResponses?: readonly PersistedHostTurnResponse[],
): SessionMetadata {
  const normalizedTitle = normalizeChatSessionTitleText(metadata.title);
  const explicitSource = normalizePersistedChatSessionTitleSource(metadata.titleSource);
  const derivedDefaultTitle = normalizeChatSessionTitleText(metadata.defaultTitle)
    || deriveDefaultTitleFromTurnResponses(turnResponses as readonly PersistedHostTurnResponse[] | undefined);

  let nextTitle = normalizedTitle;
  let nextTitleSource: PersistedChatSessionTitleSource | undefined = explicitSource;
  if (!nextTitleSource && nextTitle) {
    if (derivedDefaultTitle && nextTitle === derivedDefaultTitle) {
      nextTitle = '';
    } else {
      nextTitleSource = 'legacy-custom';
    }
  }

  const nextMetadata: SessionMetadata = {
    ...metadata,
    title: nextTitle,
  };
  if (nextTitleSource && nextTitle) {
    nextMetadata.titleSource = nextTitleSource;
  } else {
    delete nextMetadata.titleSource;
  }
  if (derivedDefaultTitle) {
    nextMetadata.defaultTitle = derivedDefaultTitle;
  } else {
    delete nextMetadata.defaultTitle;
  }

  return nextMetadata;
}

function cloneTurnRound(round: TurnResponseTurn['rounds'][number]): TurnResponseTurn['rounds'][number] {
  const summary = normalizeRoundSummary(round.summary);

  return {
    id: round.id,
    assistantText: round.assistantText,
    toolCalls: round.toolCalls.map(toolCall => ({
      ...toolCall,
      input: { ...toolCall.input },
    })),
    timestamp: round.timestamp,
    ...(summary ? { summary } : {}),
  };
}

export interface HostSessionRecordStoreOptions {
  projectChatDir: string;
  getGlobalChatDataDir: () => string;
  getGlobalProjectRootPath: () => string | null;
  joinPath: (...parts: string[]) => string;
  isSamePath: (a: string | null | undefined, b: string | null | undefined) => boolean;
  resolveModeById?: HostSessionSelectedModeResolveOptions['resolveModeById'];
  resolveModeByName?: HostSessionSelectedModeResolveOptions['resolveModeByName'];
}

/**
 * Host-side persistence adapter for chat history records.
 *
 * Keeps host record disk IO and compatibility normalization out of ChatHistoryService.
 */
export class HostSessionRecordStore {
  private readonly operationLogs = new Map<string, HostSessionOperationLog>();
  private readonly asyncWriteQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: HostSessionRecordStoreOptions) {}

  createFullMetadata(metadata: Partial<SessionMetadata> & { sessionId: string }): SessionMetadata {
    const now = Date.now();
    const sanitizedMetadata = stripLegacyRuntimeAuxiliaryFromMetadata(metadata);
    const selectedMode = resolveHostSessionSummaryModeFromMetadata(sanitizedMetadata);
    const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(sanitizedMetadata, this.getModeResolveOptions());
    return {
      sessionId: sanitizedMetadata.sessionId,
      title: normalizeChatSessionTitleText(sanitizedMetadata.title),
      ...(normalizePersistedChatSessionTitleSource(sanitizedMetadata.titleSource)
        ? { titleSource: normalizePersistedChatSessionTitleSource(sanitizedMetadata.titleSource) }
        : {}),
      ...(normalizeChatSessionTitleText(sanitizedMetadata.defaultTitle)
        ? { defaultTitle: normalizeChatSessionTitleText(sanitizedMetadata.defaultTitle) }
        : {}),
      sessionType: normalizeChatSessionType(sanitizedMetadata.sessionType),
      projectPath: sanitizedMetadata.projectPath ?? null,
      sessionScopeSchemaVersion: 1,
      createdAt: sanitizedMetadata.createdAt || now,
      updatedAt: now,
      mode: selectedMode.modeId,
      ...(readChatAgentRuntimeModeFromMetadata(sanitizedMetadata)
        ? { agentRuntimeMode: readChatAgentRuntimeModeFromMetadata(sanitizedMetadata) }
        : {}),
      ...(readChatAgentRuntimeModeSourceFromMetadata(sanitizedMetadata)
        ? { agentRuntimeModeSource: readChatAgentRuntimeModeSourceFromMetadata(sanitizedMetadata) }
        : {}),
      modeDescriptor,
      ...(sanitizedMetadata.inputState
        ? { inputState: normalizeHostSessionInputStateFromMetadata(sanitizedMetadata, this.getModeResolveOptions()) }
        : {}),
      ...(sanitizedMetadata.requestRouting
        ? { requestRouting: normalizeHostSessionRequestRoutingSummary(sanitizedMetadata.requestRouting, selectedMode) }
        : {}),
      ...(sanitizedMetadata.interactionActionSummary
        ? { interactionActionSummary: normalizeHostSessionInteractionActionSummary(sanitizedMetadata.interactionActionSummary) }
        : {}),
      model: sanitizedMetadata.model ?? null,
      contextBudget: sanitizedMetadata.contextBudget,
      ...(sanitizedMetadata.forkKind === 'protocol' || sanitizedMetadata.forkKind === 'transcript'
        ? { forkKind: sanitizedMetadata.forkKind }
        : {}),
      ...(typeof sanitizedMetadata.forkedFromSessionId === 'string' && sanitizedMetadata.forkedFromSessionId.length > 0
        ? { forkedFromSessionId: sanitizedMetadata.forkedFromSessionId }
        : {}),
      ...(typeof sanitizedMetadata.forkedBeforeTurnId === 'string' && sanitizedMetadata.forkedBeforeTurnId.length > 0
        ? { forkedBeforeTurnId: sanitizedMetadata.forkedBeforeTurnId }
        : {}),
      ...(typeof sanitizedMetadata.forkedRetainedTurnCount === 'number' && Number.isFinite(sanitizedMetadata.forkedRetainedTurnCount) && sanitizedMetadata.forkedRetainedTurnCount >= 0
        ? { forkedRetainedTurnCount: sanitizedMetadata.forkedRetainedTurnCount }
        : {}),
      toolCallingIteration: sanitizedMetadata.toolCallingIteration || 0,
    };
  }

  createRecord(
    metadata: SessionMetadata,
    turnResponses?: PersistedHostTurnResponse[],
    sidecar?: HostSessionSidecar,
    auxiliary?: HostSessionRuntimeAuxiliary,
  ): HostSessionRecord {
    const runtimeAuxiliary = cloneHostSessionRuntimeAuxiliary(auxiliary ?? {
      requestContext: metadata.requestContext,
      activeSkillNames: metadata.activeSkillNames,
    });
    const record: HostSessionRecord = {
      metadata: stripLegacyRuntimeAuxiliaryFromMetadata(metadata),
      ...(runtimeAuxiliary ? { auxiliary: runtimeAuxiliary } : {}),
    };

    const normalizedTurnResponses = this.normalizeTurnResponses(turnResponses);
    if (normalizedTurnResponses?.length) {
      record.turnResponses = normalizedTurnResponses;
    }

    record.metadata = normalizePersistedSessionTitleMetadata(record.metadata, normalizedTurnResponses);

    const normalizedSidecar = this.normalizeSidecar(sidecar);
    if (normalizedSidecar) {
      record.sidecar = normalizedSidecar;
    }

    const selectedMode = resolveHostSessionSelectedMode(record, this.getModeResolveOptions());
    const requestRouting = hasHostSessionExplicitTurnRequestRouting(record.turnResponses)
      ? resolveHostSessionRequestRoutingSummary(record)
      : record.metadata.requestRouting
        ? normalizeHostSessionRequestRoutingSummary(record.metadata.requestRouting, selectedMode)
        : (selectedMode.customAgentTarget
          ? ({ customAgentTarget: selectedMode.customAgentTarget } as SessionMetadata['requestRouting'])
          : undefined);
    const interactionActionSummary = resolveHostSessionInteractionActionSummary(record);
    record.metadata.mode = selectedMode.modeId;
    record.metadata.modeDescriptor = resolveHostSessionModeDescriptor(record, this.getModeResolveOptions());
    record.metadata.inputState = resolveHostSessionInputState(record, this.getModeResolveOptions());
    if (requestRouting) {
      record.metadata.requestRouting = requestRouting;
    } else {
      delete record.metadata.requestRouting;
    }
    record.metadata.interactionActionSummary = interactionActionSummary;

    return record;
  }

  write(sessionId: string, data: HostSessionRecord): void {
    try {
      this.writeOrThrow(sessionId, data);
    } catch (error) {
      console.warn(`[ChatHistory] 写入宿主持久化记录失败 (${sessionId}):`, error);
    }
  }

  writeOrThrow(sessionId: string, data: HostSessionRecord): void {
    if (!this.hasFs()) return;

    let projectPath = data.metadata.projectPath;
    if (projectPath) {
      const rootPath = this.options.getGlobalProjectRootPath();
      if (rootPath && this.options.isSamePath(projectPath, rootPath)) {
        console.warn(`[ChatHistory] 检测到 projectPath 等于 projectRootPath，降级为全局兜底: ${projectPath}`);
        projectPath = null;
        data.metadata.projectPath = null;
      }
    }

    if (projectPath) {
      const dir = this.options.joinPath(projectPath, this.options.projectChatDir);
      this.ensureDir(dir);
      const filePath = this.options.joinPath(dir, `${sessionId}.jsonl`);
      this.writeOperationLog(filePath, data);
      return;
    }

    const dir = this.options.getGlobalChatDataDir();
    this.ensureDir(dir);
    const filePath = this.options.joinPath(dir, `${sessionId}.jsonl`);
    this.writeOperationLog(filePath, data);
  }

  read(sessionId: string, projectPath: string | null): HostSessionRecord | null {
    if (!this.hasFs()) return null;

    const paths: string[] = [];
    if (projectPath) {
      paths.push(this.options.joinPath(projectPath, this.options.projectChatDir, `${sessionId}.jsonl`));
    }
    paths.push(this.options.joinPath(this.options.getGlobalChatDataDir(), `${sessionId}.jsonl`));

    for (const filePath of paths) {
      try {
        if (!this.fileExists(filePath)) {
          continue;
        }

        const readStartedAt = performance.now();
        const content = this.readFileSync(filePath);
        ChatPerformanceTracer.recordDuration(
          'host_record_file_read',
          performance.now() - readStartedAt,
          `bytes=${content.length}`,
          { slowThresholdMs: 16 },
        );

        let log = this.operationLogs.get(filePath);
        if (!log) {
          log = new HostSessionOperationLog();
          this.operationLogs.set(filePath, log);
        }
        const parseStartedAt = performance.now();
        let parsed: HostSessionRecord;
        try {
          parsed = log.read(content);
        } finally {
          ChatPerformanceTracer.recordDuration(
            'host_record_operation_log_parse',
            performance.now() - parseStartedAt,
            `bytes=${content.length}`,
            { slowThresholdMs: 16 },
          );
        }
        if (content.length >= HOST_SESSION_OPERATION_LOG_COMPACT_AFTER_BYTES) {
          try {
            this.writeFileSync(filePath, log.createInitial(parsed));
          } catch (error) {
            log.read(content);
            console.warn(`[ChatHistory] Failed to compact oversized host session operation log (${filePath}):`, error);
          }
        }

        if (Array.isArray(parsed)) {
          console.warn(`[ChatHistory] 忽略旧版 chatList-only 宿主持久化记录 (${filePath})`);
          continue;
        }

        if (parsed.metadata && Array.isArray(parsed.turnResponses)) {
          const normalizeStartedAt = performance.now();
          try {
            return this.normalizeRecord(parsed, sessionId, projectPath);
          } finally {
            ChatPerformanceTracer.recordDuration(
              'host_record_normalize',
              performance.now() - normalizeStartedAt,
              `turns=${parsed.turnResponses.length}`,
              { slowThresholdMs: 16 },
            );
          }
        }
      } catch (error) {
        console.warn(`[ChatHistory] 读取宿主持久化记录失败 (${filePath}):`, error);
      }
    }

    return null;
  }

  private normalizeRecord(raw: any, sessionId: string, projectPath: string | null): HostSessionRecord | null {
    if (!raw || !Array.isArray(raw.turnResponses)) {
      return null;
    }

    const turnResponses = raw.turnResponses;
    const hostRecord: HostSessionRecord = {
      metadata: this.normalizeMetadata(raw.metadata, sessionId, projectPath),
    };

    const runtimeAuxiliary = this.normalizeRuntimeAuxiliary(raw);
    if (runtimeAuxiliary) {
      hostRecord.auxiliary = runtimeAuxiliary;
    }

    const normalizedTurnResponses = this.normalizeTurnResponses(turnResponses);
    if (normalizedTurnResponses?.length) {
      hostRecord.turnResponses = normalizedTurnResponses;
    }

    const normalizedSidecar = this.normalizeSidecar(raw.sidecar);
    if (normalizedSidecar) {
      hostRecord.sidecar = normalizedSidecar;
    }

    hostRecord.metadata = normalizePersistedSessionTitleMetadata(hostRecord.metadata, normalizedTurnResponses);

    const selectedMode = resolveHostSessionSelectedMode(hostRecord, this.getModeResolveOptions());
    const requestRouting = hasHostSessionExplicitTurnRequestRouting(hostRecord.turnResponses)
      ? resolveHostSessionRequestRoutingSummary(hostRecord)
      : hostRecord.metadata.requestRouting
        ? normalizeHostSessionRequestRoutingSummary(hostRecord.metadata.requestRouting, selectedMode)
        : (selectedMode.customAgentTarget
          ? ({ customAgentTarget: selectedMode.customAgentTarget } as SessionMetadata['requestRouting'])
          : undefined);
    const interactionActionSummary = resolveHostSessionInteractionActionSummary(hostRecord);
    hostRecord.metadata.mode = selectedMode.modeId;
    hostRecord.metadata.modeDescriptor = resolveHostSessionModeDescriptor(hostRecord, this.getModeResolveOptions());
    hostRecord.metadata.inputState = resolveHostSessionInputState(hostRecord, this.getModeResolveOptions());
    if (requestRouting) {
      hostRecord.metadata.requestRouting = requestRouting;
    } else {
      delete hostRecord.metadata.requestRouting;
    }
    hostRecord.metadata.interactionActionSummary = interactionActionSummary;

    return hostRecord;
  }

  private normalizeTurnResponses(turnResponses?: readonly PersistedHostTurnResponse[]): PersistedHostTurnResponse[] | undefined {
    return turnResponses?.length ? turnResponses.map(turn => this.cloneTurnResponse(turn)) : undefined;
  }

  private cloneTurnResponse(turn: PersistedHostTurnResponse): PersistedHostTurnResponse {
    const {
      modeId: _modeId,
      modeSelection: _modeSelection,
      requestRouting: _turnRequestRouting,
      planPart: _planPart,
      handoffAction: _handoffAction,
      runtimeTruth: _runtimeTruth,
      ...turnWithoutEnvelope
    } = turn;
    const {
      followups,
      responseId,
      responseMarkdownInfo,
      modelState,
      vote,
      timestamp,
      elapsedMs,
      timeSpentWaiting,
      completionTokens,
      continuation,
      ...responseWithoutPersistedData
    } = turn.response as TurnResponseTurn['response'] & PersistedHostResponseData & {
      followups?: readonly TurnResponseFollowup[];
      continuation?: TurnResponseTurn['response']['continuation'];
    };
    const requestRouting = resolveHostSessionTurnRequestRoutingSummary(turn, turn.modeId);
    const modeSelection = requestRouting
      ? normalizeChatSelectedMode({
          modeId: requestRouting.selectedModeId,
          customAgentTarget: requestRouting.customAgentTarget,
        })
      : undefined;
    const modeId = requestRouting?.requestModeId ?? requestRouting?.selectedModeId;
    const planPart = this.normalizePersistedTurnPlanPart(turn.planPart)
      ?? this.findPersistedTurnPlanPart(turn.response.parts);
    const handoffAction = normalizeHostSessionInteractionActionSummary(turn.handoffAction)
      ?? this.resolveTurnInteractionActionSummary(turn);
    const runtimeTruth = normalizeHostSessionTurnRuntimeTruth(turn.runtimeTruth)
      ?? readHostSessionTurnRuntimeTruthFromMetadata(turn.request?.metadata);
    const responseParts = this.materializeEnvelopePlanPart(
      turn.response.parts
        .filter(part => !this.isScopedSubagentPlanPart(part))
        .map(part => clonePersistedValue(part)),
      planPart,
    );

    return {
      ...turnWithoutEnvelope,
      ...(modeId ? { modeId } : {}),
      ...(modeSelection ? { modeSelection } : {}),
      ...(requestRouting ? { requestRouting } : {}),
      ...(planPart ? { planPart } : {}),
      ...(handoffAction ? { handoffAction } : {}),
      ...(runtimeTruth ? { runtimeTruth } : {}),
      request: {
        ...turn['request'],
        ...(turn.request?.metadata ? { metadata: clonePersistedValue(turn.request.metadata) } : {}),
        ...(Array.isArray(turn.request?.attachments)
          ? { attachments: turn.request.attachments.map(attachment => clonePersistedValue(attachment)) }
          : {}),
      },
      rounds: turn['rounds'].map(round => cloneTurnRound(round)),
      ...(turn['usage'] ? { usage: { ...turn['usage'] } } : {}),
      response: {
        ...responseWithoutPersistedData,
        ...(turn.response.usedContext
          ? {
            usedContext: {
              ...turn.response.usedContext,
              documents: turn.response.usedContext.documents.map(document => ({
                ...document,
                ranges: document.ranges.map(range => ({ ...range })),
              })),
            },
          }
          : {}),
        contentReferences: (turn.response.contentReferences ?? []).map(reference => ({
          ...reference,
          ...(reference.options
            ? {
              options: {
                ...reference.options,
                ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
                ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
              },
            }
            : {}),
        })),
        codeCitations: (turn.response.codeCitations ?? []).map(citation => ({ ...citation })),
        progressMessages: (turn.response.progressMessages ?? []).map(message => ({ ...message })),
        parts: responseParts,
        ...(continuation
          ? {
              continuation: {
                ...continuation,
                ...(cloneContinuationBudgets(continuation) ? { budgets: cloneContinuationBudgets(continuation) } : {}),
                ...(cloneContinuationDiagnostics(continuation) ? { diagnostics: cloneContinuationDiagnostics(continuation) } : {}),
                ...(continuation.pendingState ? { pendingState: { ...continuation.pendingState } } : {}),
              },
            }
          : {}),
        ...(typeof responseId === 'string' && responseId.length > 0 ? { responseId } : {}),
        ...(Array.isArray(responseMarkdownInfo)
          ? {
              responseMarkdownInfo: responseMarkdownInfo
                .filter(info => !!info && typeof info.suggestionId === 'string' && info.suggestionId.length > 0)
                .map(info => ({ suggestionId: info.suggestionId })),
            }
          : {}),
        ...(Array.isArray(followups) ? { followups: followups.map(followup => ({ ...followup })) } : {}),
        ...(modelState && typeof modelState.value === 'number' ? { modelState: { ...modelState } } : {}),
        ...(vote === 0 || vote === 1 ? { vote } : {}),
        ...(typeof timestamp === 'number' ? { timestamp } : {}),
        ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
        ...(typeof timeSpentWaiting === 'number' ? { timeSpentWaiting } : {}),
        ...(typeof completionTokens === 'number' ? { completionTokens } : {}),
      },
    } satisfies PersistedHostTurnResponse;
  }

  private normalizePersistedTurnPlanPart(value: unknown): PlanPart | undefined {
    const part = isRecord(value) ? value : undefined;
    if (!part || part['type'] !== 'plan') {
      return undefined;
    }
    if (this.isScopedSubagentPlanPart(part)) {
      return undefined;
    }

    const status = part['status'] === 'streaming' || part['status'] === 'completed' || part['status'] === 'failed'
      ? part['status']
      : undefined;
    const text = typeof part['text'] === 'string' ? part['text'] : '';
    if (!status || text.length === 0) {
      return undefined;
    }

    return {
      type: 'plan',
      ...(typeof part['partId'] === 'string' && part['partId'].trim().length > 0 ? { partId: part['partId'].trim() } : {}),
      status,
      text,
      ...(Array.isArray(part['steps']) ? { steps: clonePersistedValue(part['steps']) as PlanPart['steps'] } : {}),
      ...(Array.isArray(part['assumptions']) ? { assumptions: part['assumptions'].filter((item): item is string => typeof item === 'string') } : {}),
      ...(Array.isArray(part['verification']) ? { verification: part['verification'].filter((item): item is string => typeof item === 'string') } : {}),
      ...(part['source'] === 'proposed_plan' || part['source'] === 'plan_file' || part['source'] === 'summary'
        ? { source: part['source'] }
        : {}),
    };
  }

  private isScopedSubagentPlanPart(value: unknown): boolean {
    const part = isRecord(value) ? value : undefined;
    if (!part || part['type'] !== 'plan') {
      return false;
    }
    const metadata = isRecord(part['metadata']) ? part['metadata'] : undefined;
    return part['sourceAgentRole'] === 'subagent'
      || typeof part['subAgentInvocationId'] === 'string'
      || typeof part['parentToolCallId'] === 'string'
      || metadata?.['sourceAgentRole'] === 'subagent'
      || typeof metadata?.['subAgentInvocationId'] === 'string'
      || typeof metadata?.['parentToolCallId'] === 'string';
  }

  private findPersistedTurnPlanPart(parts: readonly TurnResponseTurn['response']['parts'][number][]): PlanPart | undefined {
    for (const part of parts) {
      const planPart = this.normalizePersistedTurnPlanPart(part);
      if (planPart) {
        return planPart;
      }
    }

    return undefined;
  }

  private materializeEnvelopePlanPart(
    parts: TurnResponseTurn['response']['parts'],
    planPart: PlanPart | undefined,
  ): TurnResponseTurn['response']['parts'] {
    if (!planPart) {
      return parts;
    }

    const envelopePartId = typeof planPart.partId === 'string' ? planPart.partId.trim() : '';
    const hasSamePlanPart = parts.some((part) => {
      const persistedPlanPart = this.normalizePersistedTurnPlanPart(part);
      if (!persistedPlanPart) {
        return false;
      }
      const partId = typeof persistedPlanPart.partId === 'string' ? persistedPlanPart.partId.trim() : '';
      return envelopePartId
        ? partId === envelopePartId
        : persistedPlanPart.text === planPart.text && persistedPlanPart.status === planPart.status;
    });

    return hasSamePlanPart ? parts : [...parts, planPart as TurnResponseTurn['response']['parts'][number]];
  }

  private resolveTurnInteractionActionSummary(
    turn: PersistedHostTurnResponse,
  ): ReturnType<typeof normalizeHostSessionInteractionActionSummary> {
    const metadata = isRecord(turn.request?.metadata) ? turn.request.metadata : undefined;
    const interactionAction = isRecord(metadata?.['interactionAction'])
      ? metadata['interactionAction']
      : undefined;
    if (!interactionAction) {
      return undefined;
    }

    const payload = isRecord(interactionAction['payload']) ? interactionAction['payload'] : undefined;
    return normalizeHostSessionInteractionActionSummary({
      kind: interactionAction['kind'],
      result: payload?.['result'] ?? interactionAction['result'],
      actionId: payload?.['actionId'] ?? interactionAction['actionId'],
      feedback: payload?.['feedback'] ?? interactionAction['feedback'],
      sourceEvent: payload?.['sourceEvent'] ?? interactionAction['sourceEvent'],
    });
  }

  private normalizeSidecar(sidecar: HostSessionSidecar | undefined): HostSessionSidecar | undefined {
    const compatMessages = Array.isArray(sidecar?.response?.compatMessages)
      ? [...sidecar.response.compatMessages]
      : undefined;
    const checkpointTimeline = sidecar?.checkpointRedoBranch ?? sidecar?.checkpointTimeline;
    const checkpointTimelineSessionResource = typeof checkpointTimeline?.sessionResource === 'string'
      ? checkpointTimeline.sessionResource.trim()
      : '';
    const checkpointTimelineTurnResponses = this.normalizeTurnResponses(checkpointTimeline?.turnResponses);
    const checkpointTimelineEntries = this.normalizeCheckpointTimelineEntries(checkpointTimeline?.checkpoints);
    const normalizedCheckpointTimeline = checkpointTimelineSessionResource
      && checkpointTimelineTurnResponses?.length
      && typeof checkpointTimeline?.currentCheckpointIndex === 'number'
      && Number.isFinite(checkpointTimeline.currentCheckpointIndex)
      ? {
          sessionResource: checkpointTimelineSessionResource,
          currentCheckpointIndex: this.normalizeCheckpointIndex(
            checkpointTimeline.currentCheckpointIndex,
            checkpointTimelineEntries?.length ?? checkpointTimelineTurnResponses.length,
          ),
          ...(typeof checkpointTimeline.currentTurnResponseCount === 'number' && Number.isFinite(checkpointTimeline.currentTurnResponseCount)
            ? { currentTurnResponseCount: this.normalizeTurnResponseCount(checkpointTimeline.currentTurnResponseCount, checkpointTimelineTurnResponses.length) }
            : {}),
          ...(checkpointTimelineEntries?.length ? { checkpoints: checkpointTimelineEntries } : {}),
          turnResponses: checkpointTimelineTurnResponses,
        }
      : undefined;

    const checkpointMarker = sidecar?.checkpointMarker;
    const checkpointMarkerSessionResource = typeof checkpointMarker?.sessionResource === 'string'
      ? checkpointMarker.sessionResource.trim()
      : '';
    const markerCheckpointCount = normalizedCheckpointTimeline?.checkpoints?.length
      ?? normalizedCheckpointTimeline?.turnResponses.length
      ?? (typeof checkpointMarker?.currentCheckpointIndex === 'number'
        ? Math.max(0, Math.trunc(checkpointMarker.currentCheckpointIndex) + 1)
        : 0);
    const markerTurnResponseCount = normalizedCheckpointTimeline?.turnResponses.length
      ?? (typeof checkpointMarker?.currentTurnResponseCount === 'number'
        ? Math.max(0, Math.trunc(checkpointMarker.currentTurnResponseCount))
        : 0);
    const normalizedCheckpointMarker = checkpointMarkerSessionResource
      && typeof checkpointMarker?.currentCheckpointIndex === 'number'
      && Number.isFinite(checkpointMarker.currentCheckpointIndex)
      ? {
          sessionResource: checkpointMarkerSessionResource,
          currentCheckpointIndex: this.normalizeCheckpointIndex(checkpointMarker.currentCheckpointIndex, markerCheckpointCount),
          ...(typeof checkpointMarker.currentTurnResponseCount === 'number' && Number.isFinite(checkpointMarker.currentTurnResponseCount)
            ? { currentTurnResponseCount: this.normalizeTurnResponseCount(checkpointMarker.currentTurnResponseCount, markerTurnResponseCount) }
            : {}),
        }
      : undefined;

    if (!compatMessages?.length && !normalizedCheckpointMarker && !normalizedCheckpointTimeline) {
      return undefined;
    }

    return {
      ...(compatMessages?.length
        ? {
            response: {
              compatMessages,
            },
          }
        : {}),
      ...(normalizedCheckpointMarker ? { checkpointMarker: normalizedCheckpointMarker } : {}),
      ...(normalizedCheckpointTimeline ? { checkpointRedoBranch: normalizedCheckpointTimeline } : {}),
    };
  }

  async writeAsync(sessionId: string, data: HostSessionRecord): Promise<void> {
    try {
      await this.writeOrThrowAsync(sessionId, data);
    } catch (error) {
      console.warn(`[ChatHistory] Failed to write host persistence record (${sessionId}):`, error);
    }
  }

  async writeOrThrowAsync(sessionId: string, data: HostSessionRecord): Promise<void> {
    if (!this.hasFs()) return;

    let projectPath = data.metadata.projectPath;
    if (projectPath) {
      const rootPath = this.options.getGlobalProjectRootPath();
      if (rootPath && this.options.isSamePath(projectPath, rootPath)) {
        projectPath = null;
        data.metadata.projectPath = null;
      }
    }

    const dir = projectPath
      ? this.options.joinPath(projectPath, this.options.projectChatDir)
      : this.options.getGlobalChatDataDir();
    const filePath = this.options.joinPath(dir, `${sessionId}.jsonl`);
    await this.enqueueAsyncWrite(filePath, async () => {
      await this.ensureDirAsync(dir);
      await this.writeOperationLogAsync(filePath, data);
    });
  }

  private normalizeCheckpointTimelineEntries(value: unknown): HostSessionCheckpointTimelineEntrySidecar[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const entries = value
      .map((entry): HostSessionCheckpointTimelineEntrySidecar | null => {
        if (!isRecord(entry)) {
          return null;
        }
        const checkpointId = typeof entry['checkpointId'] === 'string' ? entry['checkpointId'].trim() : '';
        const requestId = typeof entry['requestId'] === 'string' ? entry['requestId'].trim() : '';
        const turnId = typeof entry['turnId'] === 'string' ? entry['turnId'].trim() : '';
        const turnIndex = typeof entry['turnIndex'] === 'number' && Number.isFinite(entry['turnIndex'])
          ? Math.max(0, Math.trunc(entry['turnIndex']))
          : -1;
        if (!checkpointId || !requestId || turnIndex < 0) {
          return null;
        }
        return {
          checkpointId,
          requestId,
          ...(turnId ? { turnId } : {}),
          turnIndex,
          ...(isRecord(entry['metadata'])
            ? { metadata: clonePersistedValue(entry['metadata']) as unknown as HostSessionCheckpointTimelineEntrySidecar['metadata'] }
            : {}),
        };
      })
      .filter((entry): entry is HostSessionCheckpointTimelineEntrySidecar => !!entry);
    return entries.length > 0 ? entries : undefined;
  }

  private normalizeCheckpointIndex(value: number, checkpointCount: number): number {
    if (checkpointCount <= 0) {
      return -1;
    }
    return Math.max(-1, Math.min(Math.trunc(value), checkpointCount - 1));
  }

  private normalizeTurnResponseCount(value: number, turnResponseCount: number): number {
    return Math.max(0, Math.min(Math.trunc(value), turnResponseCount));
  }

  private normalizeMetadata(raw: any, sessionId: string, projectPath: string | null): SessionMetadata {
    const now = Date.now();
    const metadata = raw && typeof raw === 'object' ? raw : {};
    const sanitizedMetadata = stripLegacyRuntimeAuxiliaryFromMetadata(metadata);
    const selectedMode = resolveHostSessionSummaryModeFromMetadata(sanitizedMetadata);
    const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(sanitizedMetadata, this.getModeResolveOptions());
    const rawToolSourceTokens = sanitizedMetadata.contextBudget?.toolSourceTokens;
    const toolSourceTokens = rawToolSourceTokens && typeof rawToolSourceTokens === 'object'
      ? Object.fromEntries(
          Object.entries(rawToolSourceTokens)
            .filter((entry): entry is [string, number] => (
              typeof entry[0] === 'string'
              && entry[0].length > 0
              && typeof entry[1] === 'number'
              && Number.isFinite(entry[1])
              && entry[1] > 0
            )),
        )
      : {};
    return {
      sessionId: typeof sanitizedMetadata.sessionId === 'string' && sanitizedMetadata.sessionId ? sanitizedMetadata.sessionId : sessionId,
      title: normalizeChatSessionTitleText(sanitizedMetadata.title),
      ...(normalizePersistedChatSessionTitleSource(sanitizedMetadata.titleSource)
        ? { titleSource: normalizePersistedChatSessionTitleSource(sanitizedMetadata.titleSource) }
        : {}),
      ...(normalizeChatSessionTitleText(sanitizedMetadata.defaultTitle)
        ? { defaultTitle: normalizeChatSessionTitleText(sanitizedMetadata.defaultTitle) }
        : {}),
      sessionType: normalizeChatSessionType(sanitizedMetadata.sessionType),
      projectPath: sanitizedMetadata.projectPath ?? projectPath ?? null,
      sessionScopeSchemaVersion: 1,
      createdAt: typeof sanitizedMetadata.createdAt === 'number' ? sanitizedMetadata.createdAt : now,
      updatedAt: typeof sanitizedMetadata.updatedAt === 'number' ? sanitizedMetadata.updatedAt : now,
      mode: selectedMode.modeId,
      ...(readChatAgentRuntimeModeFromMetadata(sanitizedMetadata)
        ? { agentRuntimeMode: readChatAgentRuntimeModeFromMetadata(sanitizedMetadata) }
        : {}),
      ...(readChatAgentRuntimeModeSourceFromMetadata(sanitizedMetadata)
        ? { agentRuntimeModeSource: readChatAgentRuntimeModeSourceFromMetadata(sanitizedMetadata) }
        : {}),
      modeDescriptor: resolveHostSessionModeDescriptorFromMetadata(sanitizedMetadata, this.getModeResolveOptions()),
      ...(sanitizedMetadata.inputState
        ? { inputState: normalizeHostSessionInputStateFromMetadata(sanitizedMetadata, this.getModeResolveOptions()) }
        : {}),
      ...(sanitizedMetadata.requestRouting
        ? { requestRouting: normalizeHostSessionRequestRoutingSummary(sanitizedMetadata.requestRouting, selectedMode) }
        : {}),
      ...(sanitizedMetadata.interactionActionSummary
        ? { interactionActionSummary: normalizeHostSessionInteractionActionSummary(sanitizedMetadata.interactionActionSummary) }
        : {}),
      model: typeof sanitizedMetadata.model === 'string' ? sanitizedMetadata.model : null,
      contextBudget: sanitizedMetadata.contextBudget && typeof sanitizedMetadata.contextBudget === 'object'
        ? {
            currentTokens: typeof sanitizedMetadata.contextBudget.currentTokens === 'number' ? sanitizedMetadata.contextBudget.currentTokens : 0,
            maxContextTokens: typeof sanitizedMetadata.contextBudget.maxContextTokens === 'number'
              ? sanitizedMetadata.contextBudget.maxContextTokens
              : 0,
            usagePercent: typeof sanitizedMetadata.contextBudget.usagePercent === 'number' ? sanitizedMetadata.contextBudget.usagePercent : 0,
            systemTokens: typeof sanitizedMetadata.contextBudget.systemTokens === 'number' ? sanitizedMetadata.contextBudget.systemTokens : 0,
            baseSystemTokens: typeof sanitizedMetadata.contextBudget.baseSystemTokens === 'number' ? sanitizedMetadata.contextBudget.baseSystemTokens : 0,
            instructionTokens: typeof sanitizedMetadata.contextBudget.instructionTokens === 'number' ? sanitizedMetadata.contextBudget.instructionTokens : 0,
            skillTokens: typeof sanitizedMetadata.contextBudget.skillTokens === 'number' ? sanitizedMetadata.contextBudget.skillTokens : 0,
            toolsTokens: typeof sanitizedMetadata.contextBudget.toolsTokens === 'number' ? sanitizedMetadata.contextBudget.toolsTokens : 0,
            toolSourceTokens,
            messagesTokens: typeof sanitizedMetadata.contextBudget.messagesTokens === 'number' ? sanitizedMetadata.contextBudget.messagesTokens : 0,
            toolResultsTokens: typeof sanitizedMetadata.contextBudget.toolResultsTokens === 'number' ? sanitizedMetadata.contextBudget.toolResultsTokens : 0,
            messageCount: typeof sanitizedMetadata.contextBudget.messageCount === 'number' ? sanitizedMetadata.contextBudget.messageCount : 0,
          }
        : undefined,
      toolCallingIteration: typeof sanitizedMetadata.toolCallingIteration === 'number' ? sanitizedMetadata.toolCallingIteration : 0,
      ...(sanitizedMetadata.forkKind === 'protocol' || sanitizedMetadata.forkKind === 'transcript'
        ? { forkKind: sanitizedMetadata.forkKind }
        : {}),
      ...(typeof sanitizedMetadata.forkedFromSessionId === 'string' && sanitizedMetadata.forkedFromSessionId.length > 0
        ? { forkedFromSessionId: sanitizedMetadata.forkedFromSessionId }
        : {}),
      ...(typeof sanitizedMetadata.forkedBeforeTurnId === 'string' && sanitizedMetadata.forkedBeforeTurnId.length > 0
        ? { forkedBeforeTurnId: sanitizedMetadata.forkedBeforeTurnId }
        : {}),
      ...(typeof sanitizedMetadata.forkedRetainedTurnCount === 'number' && Number.isFinite(sanitizedMetadata.forkedRetainedTurnCount) && sanitizedMetadata.forkedRetainedTurnCount >= 0
        ? { forkedRetainedTurnCount: sanitizedMetadata.forkedRetainedTurnCount }
        : {}),
    };
  }

  private normalizeRuntimeAuxiliary(raw: any): HostSessionRuntimeAuxiliary | undefined {
    const record = raw && typeof raw === 'object' ? raw : {};
    return cloneHostSessionRuntimeAuxiliary(record.auxiliary ?? {
      requestContext: record.metadata?.requestContext,
      activeSkillNames: record.metadata?.activeSkillNames,
    });
  }

  private getModeResolveOptions(): HostSessionSelectedModeResolveOptions | undefined {
    return this.options.resolveModeById || this.options.resolveModeByName
      ? {
          ...(this.options.resolveModeById ? { resolveModeById: this.options.resolveModeById } : {}),
          ...(this.options.resolveModeByName ? { resolveModeByName: this.options.resolveModeByName } : {}),
        }
      : undefined;
  }

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!AilyHost.get().fs;
  }

  private fileExists(path: string): boolean {
    try {
      return AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }

  private readFileSync(path: string): string {
    return AilyHost.get().fs.readFileSync(path, 'utf-8');
  }

  private writeFileSync(path: string, content: string): void {
    AilyHost.get().fs.writeFileSync(path, content, 'utf-8');
  }

  private appendFileSync(path: string, content: string): void {
    AilyHost.get().fs.appendFileSync(path, content);
  }

  private async fileExistsAsync(path: string): Promise<boolean> {
    const fs = AilyHost.get().fs;
    if (typeof fs.exists === 'function') {
      return fs.exists(path);
    }
    return this.fileExists(path);
  }

  private async readFileAsync(path: string): Promise<string> {
    const fs = AilyHost.get().fs;
    if (typeof fs.readFile === 'function') {
      return fs.readFile(path, 'utf-8');
    }
    return this.readFileSync(path);
  }

  private async writeFileAsync(path: string, content: string): Promise<void> {
    const fs = AilyHost.get().fs;
    if (typeof fs.writeFile === 'function') {
      await fs.writeFile(path, content, 'utf-8');
      return;
    }
    this.writeFileSync(path, content);
  }

  private async appendFileAsync(path: string, content: string): Promise<void> {
    const fs = AilyHost.get().fs;
    if (typeof fs.appendFile === 'function') {
      await fs.appendFile(path, content, 'utf-8');
      return;
    }
    this.appendFileSync(path, content);
  }

  private ensureDir(dirPath: string): void {
    if (!this.fileExists(dirPath)) {
      AilyHost.get().fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private async ensureDirAsync(dirPath: string): Promise<void> {
    const fs = AilyHost.get().fs;
    if (typeof fs.mkdir === 'function') {
      await fs.mkdir(dirPath, { recursive: true });
      return;
    }
    this.ensureDir(dirPath);
  }

  private writeOperationLog(filePath: string, data: HostSessionRecord): void {
    const log = this.getOperationLog(filePath);
    if (!this.fileExists(filePath)) {
      const content = log.createInitial(data);
      this.writeFileSync(filePath, content);
      return;
    }

    const result = log.write(data);
    if (!result.data) {
      return;
    }

    if (result.op === 'replace') {
      this.writeFileSync(filePath, result.data);
    } else {
      this.appendFileSync(filePath, result.data);
    }
    log.confirmWrite();
  }

  private async writeOperationLogAsync(filePath: string, data: HostSessionRecord): Promise<void> {
    const log = await this.getOperationLogAsync(filePath);
    if (!(await this.fileExistsAsync(filePath))) {
      await this.writeFileAsync(filePath, log.createInitial(data));
      return;
    }

    const result = log.write(data);
    if (!result.data) {
      return;
    }
    if (result.op === 'replace') {
      await this.writeFileAsync(filePath, result.data);
    } else {
      await this.appendFileAsync(filePath, result.data);
    }
    log.confirmWrite();
  }

  private getOperationLog(filePath: string): HostSessionOperationLog {
    let log = this.operationLogs.get(filePath);
    if (!log) {
      log = new HostSessionOperationLog();
      if (this.fileExists(filePath)) {
        log.read(this.readFileSync(filePath));
      }
      this.operationLogs.set(filePath, log);
    }
    return log;
  }

  private async getOperationLogAsync(filePath: string): Promise<HostSessionOperationLog> {
    let log = this.operationLogs.get(filePath);
    if (!log) {
      log = new HostSessionOperationLog();
      if (await this.fileExistsAsync(filePath)) {
        log.read(await this.readFileAsync(filePath));
      }
      this.operationLogs.set(filePath, log);
    }
    return log;
  }

  private async enqueueAsyncWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.asyncWriteQueues.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.asyncWriteQueues.set(filePath, next);
    try {
      await next;
    } finally {
      if (this.asyncWriteQueues.get(filePath) === next) {
        this.asyncWriteQueues.delete(filePath);
      }
    }
  }
}

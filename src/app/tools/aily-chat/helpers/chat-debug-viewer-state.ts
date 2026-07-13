import {
  normalizeChatSurfaceModeId,
  type ChatSessionModeDescriptor,
  type ChatSurfaceModeId,
} from '../core/chat-mode';
import { buildDialogTurnContext } from '../core/user-turn-action-target';
import type { ChatDialogViewItem } from './chat-dialog-view-items';
import type { HostSessionInteractionActionSummary } from './host-session-interaction-action';
import type { HostSessionRequestRoutingSummary } from './host-session-request-routing';
import { resolveHostSessionInteractionActionSummary } from './host-session-interaction-action';
import {
  resolveHostSessionModeDescriptorFromMetadata,
  resolveHostSessionProviderOptions,
  type HostSessionProviderOptions,
} from './host-session-input-state';
import { readPendingPlanReview } from './host-session-restore-bridge';
import { resolveHostSessionRequestContext } from './host-session-runtime-auxiliary';
import { buildHostProjectionStateFromPersistedRecord } from './host-turn-response-state';
import { resolveHostSessionRequestRoutingSummary } from './host-session-request-routing';
import type { ImportedDebugSessionRecord } from '../services/chat-history.service';
import type { HostSessionTurnRuntimeTruth } from './host-session-runtime-truth';
import {
  normalizeHostSessionTurnRuntimeTruth,
  readHostSessionTurnRuntimeTruthFromMetadata,
} from './host-session-runtime-truth';
import type {
  HostSessionDebugDualPersistenceSummary,
  HostSessionDebugLiveRuntimeOverlaySummary,
  HostSessionRestoreDiagnosticsSummary,
  HostSessionRestoreFailureSummary,
} from '../services/host-session-debug-export';

export interface ImportedDebugSurfaceModeSummary {
  readonly id: string;
  readonly kind: ChatSurfaceModeId;
  readonly label: string;
  readonly isBuiltin: boolean;
}

export interface ImportedDebugSessionViewModel {
  readonly metadata: ImportedDebugSessionRecord['hostRecord']['metadata'];
  readonly surfaceMode: ImportedDebugSurfaceModeSummary;
  readonly providerOptions: HostSessionProviderOptions;
  readonly requestRouting: HostSessionRequestRoutingSummary;
  readonly runtimeTruth?: ImportedDebugRuntimeTruthSummary;
  readonly interactionActionSummary?: HostSessionInteractionActionSummary;
  readonly pendingPlanReview?: ImportedDebugPendingPlanReviewSummary;
  readonly planParts: readonly ImportedDebugPlanPartSummary[];
  readonly deniedToolCalls: readonly ImportedDebugDeniedToolCallSummary[];
  readonly dualPersistence?: HostSessionDebugDualPersistenceSummary;
  readonly liveRuntimeOverlay?: HostSessionDebugLiveRuntimeOverlaySummary;
  readonly restoreDiagnostics?: HostSessionRestoreDiagnosticsSummary;
  readonly restoreFailure?: HostSessionRestoreFailureSummary;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly dialogItems: readonly ChatDialogViewItem[];
}

export interface ImportedDebugPendingPlanReviewSummary {
  readonly id: string;
  readonly title: string;
  readonly planUri?: string;
  readonly actionIds: readonly string[];
  readonly canProvideFeedback: boolean;
}

export interface ImportedDebugPlanPartSummary {
  readonly turnId: string;
  readonly partId?: string;
  readonly status: string;
  readonly source?: string;
  readonly owner: string;
  readonly sourceAgentRole?: string;
  readonly subAgentInvocationId?: string;
  readonly parentToolCallId?: string;
  readonly charLength: number;
  readonly preview: string;
}

export interface ImportedDebugRuntimeTruthSummary extends HostSessionTurnRuntimeTruth {
  readonly turnId: string;
}

export interface ImportedDebugDeniedToolCallSummary {
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly source: string;
  readonly reason: string;
  readonly chatMode?: string;
  readonly runtimeMode?: string;
  readonly agentRole?: string;
}

export function buildImportedDebugSessionViewModel(
  record: ImportedDebugSessionRecord,
): ImportedDebugSessionViewModel {
  const projection = buildHostProjectionStateFromPersistedRecord(record.hostRecord);

  return {
    metadata: record.hostRecord.metadata,
    surfaceMode: buildImportedDebugSurfaceModeSummary(record.hostRecord.metadata),
    providerOptions: resolveHostSessionProviderOptions(record.hostRecord),
    requestRouting: resolveHostSessionRequestRoutingSummary(record.hostRecord),
    runtimeTruth: buildLatestRuntimeTruthSummary(record),
    interactionActionSummary: resolveHostSessionInteractionActionSummary(record.hostRecord),
    pendingPlanReview: buildPendingPlanReviewSummary(record),
    planParts: buildPlanPartSummaries(record),
    deniedToolCalls: buildDeniedToolCallSummaries(record),
    ...(record.debugDualPersistence ? { dualPersistence: { ...record.debugDualPersistence } } : {}),
    ...(record.debugLiveRuntimeOverlay ? { liveRuntimeOverlay: { ...record.debugLiveRuntimeOverlay } } : {}),
    ...(record.debugRestoreDiagnostics ? { restoreDiagnostics: { ...record.debugRestoreDiagnostics } } : {}),
    ...(record.debugRestoreFailure ? { restoreFailure: { ...record.debugRestoreFailure } } : {}),
    turnCount: projection.turnResponses.length,
    messageCount: projection.dialogItems.length,
    dialogItems: projection.dialogItems.map(disableDialogItemActions),
  };
}

function buildLatestRuntimeTruthSummary(
  record: ImportedDebugSessionRecord,
): ImportedDebugRuntimeTruthSummary | undefined {
  const turns = record.hostRecord.turnResponses ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const runtimeTruth = normalizeHostSessionTurnRuntimeTruth(turn.runtimeTruth)
      ?? readHostSessionTurnRuntimeTruthFromMetadata(turn.request?.metadata);
    if (runtimeTruth) {
      return {
        turnId: typeof turn.turnId === 'string' ? turn.turnId : '',
        ...runtimeTruth,
      };
    }
  }
  return undefined;
}

function buildPlanPartSummaries(
  record: ImportedDebugSessionRecord,
): ImportedDebugPlanPartSummary[] {
  const summaries: ImportedDebugPlanPartSummary[] = [];
  for (const turn of record.hostRecord.turnResponses ?? []) {
    for (const part of resolveDebugPlanParts(turn)) {
      if (!isPlanResponsePart(part)) {
        continue;
      }
      const text = typeof part.text === 'string' ? part.text : '';
      summaries.push({
        turnId: typeof turn.turnId === 'string' ? turn.turnId : '',
        ...(typeof part.partId === 'string' && part.partId.trim() ? { partId: part.partId.trim() } : {}),
        status: typeof part.status === 'string' && part.status.trim() ? part.status.trim() : 'unknown',
        ...(typeof part.source === 'string' && part.source.trim() ? { source: part.source.trim() } : {}),
        owner: resolvePlanPartOwner(part),
        ...readPlanPartScope(part),
        charLength: text.length,
        preview: previewPlanText(text),
      });
    }
  }
  return summaries;
}

function resolveDebugPlanParts(
  turn: ImportedDebugSessionRecord['hostRecord']['turnResponses'][number],
): readonly unknown[] {
  const parts = Array.isArray(turn.response?.parts) ? [...turn.response.parts] : [];
  const envelopePlanPart = turn.planPart;
  if (!isPlanResponsePart(envelopePlanPart)) {
    return parts;
  }

  const envelopePartId = typeof envelopePlanPart.partId === 'string' ? envelopePlanPart.partId.trim() : '';
  const hasSamePlanPart = parts.some((part) => {
    if (!isPlanResponsePart(part)) {
      return false;
    }
    const partId = typeof part.partId === 'string' ? part.partId.trim() : '';
    return envelopePartId
      ? partId === envelopePartId
      : part.text === envelopePlanPart.text && part.status === envelopePlanPart.status;
  });

  return hasSamePlanPart ? parts : [...parts, envelopePlanPart];
}

function isPlanResponsePart(part: unknown): part is {
  readonly type: 'plan';
  readonly partId?: unknown;
  readonly status?: unknown;
  readonly source?: unknown;
  readonly text?: unknown;
  readonly sourceAgentRole?: unknown;
  readonly subAgentInvocationId?: unknown;
  readonly parentToolCallId?: unknown;
  readonly metadata?: unknown;
} {
  return typeof part === 'object'
    && part !== null
    && (part as { readonly type?: unknown }).type === 'plan';
}

function buildDeniedToolCallSummaries(
  record: ImportedDebugSessionRecord,
): ImportedDebugDeniedToolCallSummary[] {
  const summaries: ImportedDebugDeniedToolCallSummary[] = [];
  for (const turn of record.hostRecord.turnResponses ?? []) {
    const turnId = typeof turn.turnId === 'string' ? turn.turnId : '';
    for (const part of turn.response?.parts ?? []) {
      const summary = buildDeniedToolCallSummary(turnId, part);
      if (summary) {
        summaries.push(summary);
      }
    }
  }
  return summaries;
}

function buildDeniedToolCallSummary(
  turnId: string,
  part: unknown,
): ImportedDebugDeniedToolCallSummary | undefined {
  if (!isToolCallResponsePart(part)) {
    return undefined;
  }

  const metadata = asRecord(part.metadata);
  const governance = asRecord(metadata?.['governance']);
  if (governance?.['status'] !== 'denied') {
    return undefined;
  }

  const profile = asRecord(metadata?.['executionProfile']);
  return {
    turnId,
    ...(typeof part.toolCallId === 'string' && part.toolCallId.trim() ? { toolCallId: part.toolCallId.trim() } : {}),
    toolName: typeof part.toolName === 'string' && part.toolName.trim() ? part.toolName.trim() : '<unknown>',
    source: asNonEmptyString(governance['source']) ?? 'unknown',
    reason: asNonEmptyString(governance['reason']) ?? '<missing reason>',
    ...(asNonEmptyString(profile?.['chatMode']) ? { chatMode: asNonEmptyString(profile?.['chatMode']) } : {}),
    ...(asNonEmptyString(profile?.['runtimeMode']) ? { runtimeMode: asNonEmptyString(profile?.['runtimeMode']) } : {}),
    ...(asNonEmptyString(profile?.['agentRole']) ? { agentRole: asNonEmptyString(profile?.['agentRole']) } : {}),
  };
}

function isToolCallResponsePart(part: unknown): part is {
  readonly type: 'tool_call';
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly metadata?: unknown;
} {
  return typeof part === 'object'
    && part !== null
    && (part as { readonly type?: unknown }).type === 'tool_call';
}

function resolvePlanPartOwner(part: {
  readonly sourceAgentRole?: unknown;
  readonly subAgentInvocationId?: unknown;
  readonly parentToolCallId?: unknown;
  readonly metadata?: unknown;
}): string {
  const scope = readPlanPartScope(part);
  if (scope.sourceAgentRole) {
    return scope.sourceAgentRole;
  }
  return scope.subAgentInvocationId || scope.parentToolCallId ? 'subagent' : 'main';
}

function readPlanPartScope(part: {
  readonly sourceAgentRole?: unknown;
  readonly subAgentInvocationId?: unknown;
  readonly parentToolCallId?: unknown;
  readonly metadata?: unknown;
}): Pick<ImportedDebugPlanPartSummary, 'sourceAgentRole' | 'subAgentInvocationId' | 'parentToolCallId'> {
  const metadata = asRecord(part.metadata);
  return {
    ...(asNonEmptyString(part.sourceAgentRole) || asNonEmptyString(metadata?.['sourceAgentRole'])
      ? { sourceAgentRole: asNonEmptyString(part.sourceAgentRole) ?? asNonEmptyString(metadata?.['sourceAgentRole']) }
      : {}),
    ...(asNonEmptyString(part.subAgentInvocationId) || asNonEmptyString(metadata?.['subAgentInvocationId'])
      ? { subAgentInvocationId: asNonEmptyString(part.subAgentInvocationId) ?? asNonEmptyString(metadata?.['subAgentInvocationId']) }
      : {}),
    ...(asNonEmptyString(part.parentToolCallId) || asNonEmptyString(metadata?.['parentToolCallId'])
      ? { parentToolCallId: asNonEmptyString(part.parentToolCallId) ?? asNonEmptyString(metadata?.['parentToolCallId']) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function previewPlanText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 96 ? `${normalized.slice(0, 96)}...` : normalized;
}

function buildPendingPlanReviewSummary(
  record: ImportedDebugSessionRecord,
): ImportedDebugPendingPlanReviewSummary | undefined {
  const pendingReview = readPendingPlanReview(resolveHostSessionRequestContext(record.hostRecord)?.interactionContinuation);
  if (!pendingReview) {
    return undefined;
  }

  return {
    id: pendingReview.id,
    title: pendingReview.title,
    ...(pendingReview.planUri ? { planUri: pendingReview.planUri } : {}),
    actionIds: pendingReview.actions.map(action => action.id),
    canProvideFeedback: pendingReview.canProvideFeedback,
  };
}

function buildImportedDebugSurfaceModeSummary(
  metadata: ImportedDebugSessionRecord['hostRecord']['metadata'],
): ImportedDebugSurfaceModeSummary {
  const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(metadata);
  if (modeDescriptor) {
    return {
      id: modeDescriptor.id,
      kind: modeDescriptor.kind,
      label: resolveImportedDebugSurfaceModeLabel(modeDescriptor),
      isBuiltin: modeDescriptor.isBuiltin,
    };
  }

  const kind = normalizeChatSurfaceModeId(metadata.mode);
  return {
    id: kind,
    kind,
    label: BUILTIN_SURFACE_MODE_LABELS[kind],
    isBuiltin: true,
  };
}

function resolveImportedDebugSurfaceModeLabel(
  modeDescriptor: ChatSessionModeDescriptor,
): string {
  const candidate = !modeDescriptor.isBuiltin
    ? modeDescriptor.modeInstructions?.name?.trim() || modeDescriptor.name?.trim() || modeDescriptor.id.trim()
    : modeDescriptor.name?.trim() || BUILTIN_SURFACE_MODE_LABELS[modeDescriptor.kind];
  return candidate || modeDescriptor.id;
}

const BUILTIN_SURFACE_MODE_LABELS: Record<ChatSurfaceModeId, string> = {
  ask: 'Ask',
  edit: 'Edit',
  agent: 'Agent',
  plan: 'Plan',
};

function disableDialogItemActions(item: ChatDialogViewItem): ChatDialogViewItem {
  return {
    ...item,
    isLastAily: false,
    showCheckpointRestore: false,
    turnContext: item.turnContext
      ? buildDialogTurnContext({
        turnId: item.turnContext.turnId,
        turnResponse: item.turnContext.turnResponse,
        request: item.turnContext.request,
        response: item.turnContext.response,
        rounds: item.turnContext.rounds,
        requestDisabled: true,
        requestContent: item.turnContext.requestContent,
        displayContent: item.turnContext.displayContent,
      })
      : null,
  };
}

import { readTurnRequestDebugArtifactsSnapshot } from 'aily-lex/browser';
import type { ChatSessionTitleSource, PersistedChatSessionTitleSource } from '../core/chat-session-title';
import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  type ChatAgentRuntimeMode,
} from '../core/chat-agent-runtime-mode';
import { resolveChatSelectedCustomAgentTarget } from '../core/chat-mode';
import { BLOCKLY_PROMPT_PROFILE } from '../core/blockly-prompt-profile';
import { CODER_PROMPT_PROFILE } from '../core/coder-prompt-profile';
import { UNBOUND_ROUTER_PROMPT_PROFILE } from '../core/unbound-router-prompt-profile';

import type { HostSessionRecord, SessionIndexEntry } from './chat-history.service';
import { buildHostSessionDebugEvents, type HostSessionDebugEvent } from './host-session-debug-events';
import type { LexSessionStoredSnapshotState } from '../helpers/host-session-restore-resolver';
import type { HostSessionRestoreFailureKind } from '../helpers/host-session-restore-bridge';
import {
  resolveHostSessionInputState,
  resolveHostSessionModeDescriptor,
  resolveHostSessionSelectedMode,
  type HostSessionSelectedModeResolveOptions,
} from '../helpers/host-session-input-state';
import {
  resolveHostSessionInteractionActionSummary,
  type HostSessionInteractionActionSummary,
} from '../helpers/host-session-interaction-action';
import { resolveHostSessionRequestRoutingSummary } from '../helpers/host-session-request-routing';
import { readLatestContextUsageSummary } from './context-usage-snapshot';

const ABS_ONLY_TOOL_NAMES = new Set([
  'syncAbs',
  'lint',
  'analyzeLibrary',
  'get_project_context',
  'save_arch',
]);

export interface HostSessionDebugExportEnvelope {
  readonly kind: 'aily-chat-debug-export';
  readonly version: 1;
  readonly exportedAt: string;
  readonly source: {
    readonly owner: 'chat-history-service';
    readonly storage: 'host-session-record';
  };
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
    readonly titleSource?: ChatSessionTitleSource;
    readonly durableTitle?: string;
    readonly durableTitleSource?: PersistedChatSessionTitleSource;
    readonly defaultTitle?: string;
    readonly projectPath: string | null;
    readonly sessionScopeKind: 'global' | 'project';
    readonly sessionProjectPath: string | null;
    readonly listScopeKey: string;
    readonly storagePath?: string;
    readonly projectName: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly mode: string;
    readonly runtimeMode?: ChatAgentRuntimeMode;
    readonly runtimeModeSource?: string;
    readonly promptProfileId?: string;
    readonly modeDescriptor?: NonNullable<HostSessionRecord['metadata']['modeDescriptor']>;
    readonly inputState: NonNullable<HostSessionRecord['metadata']['inputState']>;
    readonly requestModeId?: string;
    readonly customAgentTarget?: string;
    readonly permissionLevel?: string;
    readonly approvalsReviewer?: 'user' | 'auto_review';
    readonly approvalPolicy?: 'on_request' | 'never';
    readonly interactionActionSummary?: HostSessionInteractionActionSummary;
    readonly model: string | null;
    readonly messageCount: number;
  };
  readonly hostRecord: HostSessionRecord;
  readonly debug: {
    readonly eventSource: 'derived-host-record';
    readonly events: readonly HostSessionDebugEvent[];
    readonly contextUsage?: HostSessionDebugContextUsageSummary;
    readonly dualPersistence?: HostSessionDebugDualPersistenceSummary;
    readonly liveRuntimeOverlay?: HostSessionDebugLiveRuntimeOverlaySummary;
    readonly restoreDiagnostics?: HostSessionRestoreDiagnosticsSummary;
    readonly restoreFailure?: HostSessionRestoreFailureSummary;
    readonly companionFiles?: Readonly<Record<string, string>>;
  };
}

export interface HostSessionDebugContextUsageSummary {
  readonly usageSource: 'provider-final-only' | 'provider-request-update' | 'estimate';
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly usedTokens: number;
  readonly outputBuffer?: number;
}

export interface HostSessionDebugDualPersistenceSummary {
  readonly hostRecordPath: string;
  readonly lexSnapshotPath: string;
  readonly lexSnapshotPresent: boolean;
  readonly hostTurnResponseCount: number;
  readonly lexTurnCount?: number;
  readonly displayTitle?: string;
  readonly displayTitleSource?: ChatSessionTitleSource;
  readonly hostTitle?: string;
  readonly hostTitleSource?: PersistedChatSessionTitleSource;
  readonly hostDefaultTitle?: string;
  readonly indexTitle?: string;
  readonly indexTitleSource?: PersistedChatSessionTitleSource;
  readonly indexDefaultTitle?: string;
  readonly hostPrimaryFields: readonly string[];
  readonly lexPrimaryFields: readonly string[];
  readonly hostAuxiliaryMirrors?: readonly string[];
  readonly notes?: readonly string[];
}

export interface HostSessionDebugLiveRuntimeOverlaySummary {
  readonly sessionId: string;
  readonly status?: 'in_progress' | 'needs_input' | 'completed' | 'cancelled' | 'failed';
  readonly pendingRequest: boolean;
  readonly needsInput: boolean;
  readonly attachedView: boolean;
  readonly title?: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly turnResponseCount: number;
  readonly hostProjectionPresent: boolean;
  readonly quotaOverlayPresent?: boolean;
  readonly requestQuotaNotice?: boolean;
  readonly authQuotaProjected?: boolean;
  readonly contextBudgetOverlayPresent?: boolean;
  readonly inputNoticeOverlayPresent?: boolean;
  readonly capabilities?: {
    readonly canRunConcurrently: boolean;
    readonly canContinueInPlace: boolean;
    readonly supportsBackgroundPersistence: boolean;
  };
  readonly lastExplicitInterruptAt?: number;
  readonly lastExplicitDisposeAt?: number;
  readonly lastViewDetachAt?: number;
  readonly notes?: readonly string[];
}

export interface HostSessionRestoreDiagnosticsSummary {
  readonly sessionId: string;
  readonly lexSnapshotPath: string;
  readonly storedSnapshotState: LexSessionStoredSnapshotState;
  readonly storedSnapshotError?: string;
  readonly missingActiveSkillNames?: readonly string[];
  readonly notes?: readonly string[];
}

export interface HostSessionRestoreFailureSummary {
  readonly sessionId: string;
  readonly stage: 'session-start' | 'host-restore' | 'missing-record';
  readonly projectPath: string | null;
  readonly requestSource: string;
  readonly hostRecordSource: string;
  readonly metadataSource: string;
  readonly restoreKind?: HostSessionRestoreFailureKind;
  readonly hostRecordSessionId?: string;
  readonly storedSnapshotState?: LexSessionStoredSnapshotState;
  readonly errorMessage: string;
  readonly notes?: readonly string[];
}

interface HostSessionRuntimeModeDebugSummary {
  readonly runtimeMode: ChatAgentRuntimeMode;
  readonly runtimeModeSource: string;
  readonly developmentModePreference?: HostSessionDevelopmentModePreferenceSummary;
  readonly promptProfileId: string;
  readonly promptSectionIds: readonly string[];
  readonly availableToolNames: readonly string[];
  readonly usedToolNames: readonly string[];
  readonly hasAvailableToolsSnapshot: boolean;
  readonly toolFiltering: readonly string[];
  readonly warnings: readonly string[];
}

interface HostSessionScopeDebugSummary {
  readonly sessionScopeKind: 'global' | 'project';
  readonly sessionProjectPath: string | null;
  readonly listScopeKey: string;
  readonly storagePath?: string;
  readonly entryProjectPath: string | null;
  readonly metadataProjectPath: string | null;
  readonly notes?: readonly string[];
}

export interface HostSessionDevelopmentModePreferenceSummary {
  readonly preference: string;
  readonly source?: string;
  readonly updatedAt?: number;
  readonly promptedAt?: number;
}

export interface HostSessionDebugExportAugmentation {
  readonly companionFiles?: Readonly<Record<string, string>>;
  readonly developmentModePreference?: HostSessionDevelopmentModePreferenceSummary;
  readonly dualPersistence?: HostSessionDebugDualPersistenceSummary;
  readonly liveRuntimeOverlay?: HostSessionDebugLiveRuntimeOverlaySummary;
  readonly restoreDiagnostics?: HostSessionRestoreDiagnosticsSummary;
  readonly restoreFailure?: HostSessionRestoreFailureSummary;
  readonly scopeDiagnostics?: {
    readonly notes?: readonly string[];
  };
}

export function encodeHostSessionDebugExport(
  record: HostSessionRecord,
  entry?: SessionIndexEntry,
  exportedAt = new Date(),
  options?: HostSessionSelectedModeResolveOptions,
  augmentation?: HostSessionDebugExportAugmentation,
): Uint8Array {
  const envelope = buildHostSessionDebugExportEnvelope(record, entry, exportedAt, options, augmentation);
  return new TextEncoder().encode(JSON.stringify(envelope, null, 2));
}

export function decodeHostSessionDebugExport(data: Uint8Array): HostSessionDebugExportEnvelope | null {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Partial<HostSessionDebugExportEnvelope>;
    if (parsed?.kind !== 'aily-chat-debug-export' || parsed?.version !== 1) {
      return null;
    }
    if (!parsed.hostRecord?.metadata?.sessionId || !parsed.session?.sessionId) {
      return null;
    }
    const cloned = cloneJsonValue(parsed) as HostSessionDebugExportEnvelope;
    return {
      ...cloned,
      debug: {
        eventSource: 'derived-host-record',
        events: Array.isArray(cloned.debug?.events)
          ? cloned.debug.events.map(event => ({ ...event }))
          : buildHostSessionDebugEvents(cloned.hostRecord),
        ...(cloned.debug?.contextUsage && typeof cloned.debug.contextUsage === 'object'
          ? { contextUsage: { ...cloned.debug.contextUsage } }
          : {}),
        ...(cloned.debug?.dualPersistence && typeof cloned.debug.dualPersistence === 'object'
          ? { dualPersistence: { ...cloned.debug.dualPersistence } }
          : {}),
        ...(cloned.debug?.liveRuntimeOverlay && typeof cloned.debug.liveRuntimeOverlay === 'object'
          ? { liveRuntimeOverlay: { ...cloned.debug.liveRuntimeOverlay } }
          : {}),
        ...(cloned.debug?.restoreDiagnostics && typeof cloned.debug.restoreDiagnostics === 'object'
          ? { restoreDiagnostics: { ...cloned.debug.restoreDiagnostics } }
          : {}),
        ...(cloned.debug?.restoreFailure && typeof cloned.debug.restoreFailure === 'object'
          ? { restoreFailure: { ...cloned.debug.restoreFailure } }
          : {}),
        ...(cloned.debug?.companionFiles && typeof cloned.debug.companionFiles === 'object'
          ? { companionFiles: { ...cloned.debug.companionFiles } }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

function buildHostSessionDebugExportEnvelope(
  record: HostSessionRecord,
  entry: SessionIndexEntry | undefined,
  exportedAt: Date,
  options?: HostSessionSelectedModeResolveOptions,
  augmentation?: HostSessionDebugExportAugmentation,
): HostSessionDebugExportEnvelope {
  const hostRecord = cloneJsonValue(record);
  const metadata = hostRecord.metadata;
  const selectedMode = resolveHostSessionSelectedMode(hostRecord, options);
  const modeDescriptor = resolveHostSessionModeDescriptor(hostRecord, options);
  const inputState = resolveHostSessionInputState(hostRecord, options);
  const requestRouting = resolveHostSessionRequestRoutingSummary(hostRecord);
  const customAgentTarget = requestRouting.customAgentTarget
    ?? resolveChatSelectedCustomAgentTarget(selectedMode);
  const interactionActionSummary = resolveHostSessionInteractionActionSummary(hostRecord);
  const runtimeMode = normalizeChatAgentRuntimeMode(metadata.agentRuntimeMode ?? metadata.runtimeMode, 'unbound');
  const runtimeModeSource = normalizeChatAgentRuntimeModeSource(
    metadata.agentRuntimeModeSource ?? metadata.runtimeModeSource,
    'fallback',
  );
  const durableTitle = metadata.title || entry?.title || '';
  const durableTitleSource = metadata.titleSource ?? entry?.titleSource;
  const defaultTitle = metadata.defaultTitle || entry?.defaultTitle || '';
  const displayTitle = durableTitle || defaultTitle || '';
  const titleSource: ChatSessionTitleSource = durableTitle
    ? (durableTitleSource ?? 'legacy-custom')
    : (defaultTitle ? 'default-first-request' : 'empty');
  const sessionProjectPath = metadata.projectPath ?? entry?.projectPath ?? null;
  const sessionScopeKind = sessionProjectPath ? 'project' : 'global';
  const listScopeKey = sessionProjectPath ? `project:${sessionProjectPath}` : 'global';
  const scopeDebugSummary: HostSessionScopeDebugSummary = {
    sessionScopeKind,
    sessionProjectPath,
    listScopeKey,
    ...(augmentation?.dualPersistence?.hostRecordPath
      ? { storagePath: augmentation.dualPersistence.hostRecordPath }
      : {}),
    entryProjectPath: entry?.projectPath ?? null,
    metadataProjectPath: metadata.projectPath ?? null,
    ...(augmentation?.scopeDiagnostics?.notes?.length
      ? { notes: [...augmentation.scopeDiagnostics.notes] }
      : {}),
  };
  hostRecord.metadata = {
    ...hostRecord.metadata,
    mode: selectedMode.modeId,
    modeDescriptor,
    inputState,
    requestRouting,
    ...(interactionActionSummary ? { interactionActionSummary } : {}),
  };
  const companionBundle = buildHostSessionDebugCompanionBundle(hostRecord);
  const debugEvents = attachCompanionFileRefsToDebugEvents(
    buildHostSessionDebugEvents(hostRecord),
    companionBundle.refsByTurnId,
  );
  const contextUsage = buildHostSessionDebugContextUsageSummary(hostRecord);
  const companionFiles = {
    ...companionBundle.companionFiles,
    ...(augmentation?.companionFiles ? { ...augmentation.companionFiles } : {}),
  };
  const exportedDebugEvents = [...debugEvents];
  if (contextUsage) {
    exportedDebugEvents.push(
      buildContextUsageDebugEvent(hostRecord, exportedDebugEvents.length, contextUsage),
    );
  }
  const runtimeModeDebugSummary = buildRuntimeModeDebugSummary(
    hostRecord,
    runtimeMode,
    runtimeModeSource,
    augmentation?.developmentModePreference,
    getPromptProfileIdForRuntimeMode(runtimeMode),
    companionFiles,
  );
  exportedDebugEvents.push(
    buildSessionScopeDebugEvent(hostRecord, exportedDebugEvents.length, scopeDebugSummary),
  );
  exportedDebugEvents.push(
    buildRuntimeModeDebugEvent(hostRecord, exportedDebugEvents.length, runtimeModeDebugSummary),
  );
  if (augmentation?.dualPersistence) {
    exportedDebugEvents.push(
      buildDualPersistenceDebugEvent(hostRecord, exportedDebugEvents.length, augmentation.dualPersistence),
    );
  }
  if (augmentation?.liveRuntimeOverlay) {
    exportedDebugEvents.push(
      buildLiveRuntimeOverlayDebugEvent(hostRecord, exportedDebugEvents.length, augmentation.liveRuntimeOverlay),
    );
  }
  if (augmentation?.restoreDiagnostics) {
    exportedDebugEvents.push(
      buildRestoreDiagnosticsDebugEvent(hostRecord, exportedDebugEvents.length, augmentation.restoreDiagnostics),
    );
  }
  if (augmentation?.restoreFailure) {
    exportedDebugEvents.push(
      buildRestoreFailureDebugEvent(hostRecord, exportedDebugEvents.length, augmentation.restoreFailure),
    );
  }

  return {
    kind: 'aily-chat-debug-export',
    version: 1,
    exportedAt: exportedAt.toISOString(),
    source: {
      owner: 'chat-history-service',
      storage: 'host-session-record',
    },
    session: {
      sessionId: metadata.sessionId,
      title: displayTitle,
      titleSource,
      durableTitle,
      ...(durableTitleSource ? { durableTitleSource } : {}),
      ...(defaultTitle ? { defaultTitle } : {}),
      projectPath: sessionProjectPath,
      sessionScopeKind,
      sessionProjectPath,
      listScopeKey,
      ...(augmentation?.dualPersistence?.hostRecordPath
        ? { storagePath: augmentation.dualPersistence.hostRecordPath }
        : {}),
      projectName: entry?.projectName ?? null,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      mode: selectedMode.modeId,
      runtimeMode,
      runtimeModeSource,
      promptProfileId: getPromptProfileIdForRuntimeMode(runtimeMode),
      ...(modeDescriptor ? { modeDescriptor } : {}),
      inputState,
      ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
      ...(customAgentTarget ? { customAgentTarget } : {}),
      ...(requestRouting.permissionLevel ? { permissionLevel: requestRouting.permissionLevel } : {}),
      ...(requestRouting.approvalsReviewer ? { approvalsReviewer: requestRouting.approvalsReviewer } : {}),
      ...(requestRouting.approvalPolicy ? { approvalPolicy: requestRouting.approvalPolicy } : {}),
      ...(interactionActionSummary ? { interactionActionSummary } : {}),
      model: metadata.model ?? null,
      messageCount: entry?.messageCount ?? countRecordMessages(hostRecord),
    },
    hostRecord,
    debug: {
      eventSource: 'derived-host-record',
      events: exportedDebugEvents,
      ...(contextUsage ? { contextUsage } : {}),
      ...(augmentation?.dualPersistence ? { dualPersistence: augmentation.dualPersistence } : {}),
      ...(augmentation?.liveRuntimeOverlay ? { liveRuntimeOverlay: augmentation.liveRuntimeOverlay } : {}),
      ...(augmentation?.restoreDiagnostics ? { restoreDiagnostics: augmentation.restoreDiagnostics } : {}),
      ...(augmentation?.restoreFailure ? { restoreFailure: augmentation.restoreFailure } : {}),
      ...(Object.keys(companionFiles).length > 0
        ? { companionFiles }
        : {}),
    },
  };
}

function getPromptProfileIdForRuntimeMode(runtimeMode: ChatAgentRuntimeMode): string {
  return getPromptProfileForRuntimeMode(runtimeMode).hostId;
}

function getPromptSectionIdsForRuntimeMode(runtimeMode: ChatAgentRuntimeMode): readonly string[] {
  return getPromptProfileForRuntimeMode(runtimeMode).sections.map(section => section.id);
}

function getPromptProfileForRuntimeMode(runtimeMode: ChatAgentRuntimeMode) {
  switch (runtimeMode) {
    case 'coder':
      return CODER_PROMPT_PROFILE;
    case 'blockly':
      return BLOCKLY_PROMPT_PROFILE;
    case 'unbound':
    default:
      return UNBOUND_ROUTER_PROMPT_PROFILE;
  }
}

function buildHostSessionDebugContextUsageSummary(
  record: HostSessionRecord,
): HostSessionDebugContextUsageSummary | null {
  const usage = readLatestContextUsageSummary(record.turnResponses);
  if (!usage) {
    return null;
  }

  return {
    usageSource: mapContextUsageSourceForDebugExport(usage.source),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    usedTokens: usage.promptTokens + usage.completionTokens,
    ...(typeof usage.outputBuffer === 'number' ? { outputBuffer: usage.outputBuffer } : {}),
  };
}

function mapContextUsageSourceForDebugExport(
  source: 'provider-request' | 'provider-turn-final' | 'estimate',
): HostSessionDebugContextUsageSummary['usageSource'] {
  switch (source) {
    case 'provider-request':
      return 'provider-request-update';
    case 'provider-turn-final':
      return 'provider-final-only';
    default:
      return 'estimate';
  }
}

function buildDualPersistenceDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionDebugDualPersistenceSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `dual-persistence:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Dual persistence boundary',
    details: formatDualPersistenceDetails(summary),
    level: 'info',
    category: 'session',
  };
}

function buildContextUsageDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionDebugContextUsageSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `context-usage:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Context usage source',
    details: formatContextUsageDetails(summary),
    level: 'info',
    category: 'session',
  };
}

function buildRuntimeModeDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionRuntimeModeDebugSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `runtime-mode:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Runtime mode diagnostics',
    details: formatRuntimeModeDebugDetails(summary),
    level: summary.warnings.length > 0 ? 'warning' : 'info',
    category: 'runtime-mode',
  };
}

function buildSessionScopeDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionScopeDebugSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `session-scope:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Session scope diagnostics',
    details: formatSessionScopeDebugDetails(summary),
    level: 'info',
    category: 'session',
  };
}

function buildLiveRuntimeOverlayDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionDebugLiveRuntimeOverlaySummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `live-runtime-overlay:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Live runtime overlay',
    details: formatLiveRuntimeOverlayDetails(summary),
    level: summary.pendingRequest || summary.needsInput ? 'info' : 'trace',
    category: 'session',
  };
}

function buildRestoreDiagnosticsDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionRestoreDiagnosticsSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `restore-diagnostics:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Restore Diagnostics',
    details: formatRestoreDiagnosticsDetails(summary),
    level: summary.storedSnapshotState === 'load-failed' || !!summary.missingActiveSkillNames?.length ? 'warning' : 'info',
    category: 'session',
  };
}

function buildRestoreFailureDebugEvent(
  record: HostSessionRecord,
  sequence: number,
  summary: HostSessionRestoreFailureSummary,
): HostSessionDebugEvent {
  return {
    ...buildSessionDebugExportEventBoundary(record),
    id: `restore-failure:${record.metadata.sessionId}:${sequence}`,
    sequence,
    sessionId: record.metadata.sessionId,
    turnId: '__session__',
    kind: 'generic',
    created: record.metadata.updatedAt,
    name: 'Restore Failure',
    details: formatRestoreFailureDetails(summary),
    level: 'error',
    category: 'session',
  };
}

function buildSessionDebugExportEventBoundary(
  record: HostSessionRecord,
): Pick<HostSessionDebugEvent, 'ownerSessionId' | 'selectedModeId' | 'requestModeId' | 'eventSource'> {
  const requestRouting = resolveHostSessionRequestRoutingSummary(record);
  return {
    ownerSessionId: record.metadata.sessionId,
    selectedModeId: requestRouting.selectedModeId,
    ...(requestRouting.requestModeId ? { requestModeId: requestRouting.requestModeId } : {}),
    eventSource: 'debug-export',
  };
}

function formatDualPersistenceDetails(summary: HostSessionDebugDualPersistenceSummary): string {
  const lines = [
    `host record: ${summary.hostRecordPath}`,
    `lex snapshot: ${summary.lexSnapshotPath}${summary.lexSnapshotPresent ? '' : ' (missing)'}`,
    `host turnResponses: ${summary.hostTurnResponseCount}`,
    ...(typeof summary.lexTurnCount === 'number' ? [`lex turns: ${summary.lexTurnCount}`] : []),
    ...(summary.displayTitleSource
      ? [`display title: ${summary.displayTitle || '(empty)'} [${summary.displayTitleSource}]`]
      : []),
    ...(summary.hostTitle !== undefined
      ? [`host durable title: ${summary.hostTitle || '(empty)'}${summary.hostTitleSource ? ` [${summary.hostTitleSource}]` : ''}`]
      : []),
    ...(summary.hostDefaultTitle ? [`host default title: ${summary.hostDefaultTitle}`] : []),
    ...(summary.indexTitle !== undefined
      ? [`index durable title: ${summary.indexTitle || '(empty)'}${summary.indexTitleSource ? ` [${summary.indexTitleSource}]` : ''}`]
      : []),
    ...(summary.indexDefaultTitle ? [`index default title: ${summary.indexDefaultTitle}`] : []),
    `host primary: ${summary.hostPrimaryFields.join(', ')}`,
    `lex primary: ${summary.lexPrimaryFields.join(', ')}`,
    ...(summary.hostAuxiliaryMirrors?.length ? [`host mirrors: ${summary.hostAuxiliaryMirrors.join(', ')}`] : []),
    ...(summary.notes?.length ? summary.notes.map(note => `note: ${note}`) : []),
  ];
  return lines.join('\n');
}

function formatLiveRuntimeOverlayDetails(summary: HostSessionDebugLiveRuntimeOverlaySummary): string {
  const lines = [
    `session: ${summary.sessionId}`,
    `status: ${summary.status ?? 'none'}`,
    `pendingRequest: ${summary.pendingRequest ? 'yes' : 'no'}`,
    `needsInput: ${summary.needsInput ? 'yes' : 'no'}`,
    `attachedView: ${summary.attachedView ? 'yes' : 'no'}`,
    ...(summary.titleSource
      ? [`title: ${summary.title || '(empty)'} [${summary.titleSource}]${typeof summary.titleRevision === 'number' ? ` rev=${summary.titleRevision}` : ''}`]
      : []),
    `turnResponses: ${summary.turnResponseCount}`,
    `hostProjection: ${summary.hostProjectionPresent ? 'present' : 'absent'}`,
  ];
  if (typeof summary.quotaOverlayPresent === 'boolean') {
    lines.push(`quotaOverlay: ${summary.quotaOverlayPresent ? 'present' : 'absent'}`);
  }
  if (typeof summary.requestQuotaNotice === 'boolean') {
    lines.push(`requestQuotaNotice: ${summary.requestQuotaNotice ? 'yes' : 'no'}`);
  }
  if (typeof summary.authQuotaProjected === 'boolean') {
    lines.push(`authQuotaProjected: ${summary.authQuotaProjected ? 'yes' : 'no'}`);
  }
  if (typeof summary.contextBudgetOverlayPresent === 'boolean') {
    lines.push(`contextBudgetOverlay: ${summary.contextBudgetOverlayPresent ? 'present' : 'absent'}`);
  }
  if (typeof summary.inputNoticeOverlayPresent === 'boolean') {
    lines.push(`inputNoticeOverlay: ${summary.inputNoticeOverlayPresent ? 'present' : 'absent'}`);
  }
  if (summary.capabilities) {
    lines.push(
      `capabilities: concurrent=${summary.capabilities.canRunConcurrently ? 'yes' : 'no'}, continueInPlace=${summary.capabilities.canContinueInPlace ? 'yes' : 'no'}, background=${summary.capabilities.supportsBackgroundPersistence ? 'yes' : 'no'}`,
    );
  }
  if (summary.lastViewDetachAt) {
    lines.push(`lastViewDetach: ${new Date(summary.lastViewDetachAt).toISOString()}`);
  }
  if (summary.lastExplicitInterruptAt) {
    lines.push(`lastExplicitInterrupt: ${new Date(summary.lastExplicitInterruptAt).toISOString()}`);
  }
  if (summary.lastExplicitDisposeAt) {
    lines.push(`lastExplicitDispose: ${new Date(summary.lastExplicitDisposeAt).toISOString()}`);
  }
  if (summary.notes?.length) {
    lines.push(...summary.notes.map(note => `note: ${note}`));
  }
  return lines.join('\n');
}

function buildRuntimeModeDebugSummary(
  record: HostSessionRecord,
  runtimeMode: ChatAgentRuntimeMode,
  runtimeModeSource: string,
  developmentModePreference: HostSessionDevelopmentModePreferenceSummary | undefined,
  promptProfileId: string,
  companionFiles: Readonly<Record<string, string>>,
): HostSessionRuntimeModeDebugSummary {
  const tools = collectRuntimeModeToolNames(record, companionFiles);
  const warnings: string[] = [];
  if (runtimeMode === 'blockly'
    && tools.hasAvailableToolsSnapshot
    && !tools.availableToolNames.includes('syncAbs')) {
    warnings.push('Blockly runtime does not expose syncAbs; check hostAPI or runtime:blockly capability wiring.');
  }

  if (runtimeMode === 'coder') {
    const leakedAbsTools = [...new Set([...tools.availableToolNames, ...tools.usedToolNames])]
      .filter((toolName) => ABS_ONLY_TOOL_NAMES.has(toolName));
    if (leakedAbsTools.length > 0) {
      warnings.push(`Coder runtime exposes ABS-only tools: ${leakedAbsTools.join(', ')}`);
    }
  }

  return {
    runtimeMode,
    runtimeModeSource,
    ...(developmentModePreference ? { developmentModePreference } : {}),
    promptProfileId,
    promptSectionIds: getPromptSectionIdsForRuntimeMode(runtimeMode),
    availableToolNames: tools.availableToolNames,
    usedToolNames: tools.usedToolNames,
    hasAvailableToolsSnapshot: tools.hasAvailableToolsSnapshot,
    toolFiltering: buildRuntimeModeToolFilteringNotes(runtimeMode, tools.availableToolNames),
    warnings,
  };
}

function buildRuntimeModeToolFilteringNotes(
  runtimeMode: ChatAgentRuntimeMode,
  availableToolNames: readonly string[],
): readonly string[] {
  const availableAbsTools = availableToolNames.filter(toolName => ABS_ONLY_TOOL_NAMES.has(toolName));
  const hiddenAbsTools = [...ABS_ONLY_TOOL_NAMES].filter(toolName => !availableToolNames.includes(toolName)).sort();

  switch (runtimeMode) {
    case 'blockly':
      return [
        'runtime:blockly capability is active; ABS workspace tools are eligible when the host API provides them.',
        availableAbsTools.length > 0
          ? `ABS tools enabled: ${availableAbsTools.sort().join(', ')}`
          : 'ABS tools enabled: none observed in available tools snapshot',
      ];
    case 'coder':
      return [
        'runtime:coder capability is active; ABS-only tools should be hidden by runtimeModes/requiredCapabilities.',
        `ABS-only tools expected hidden: ${hiddenAbsTools.join(', ')}`,
      ];
    case 'unbound':
    default:
      return [
        'runtime:unbound capability is active; mutation tools stay hidden until selectRuntimeMode confirms coder or blockly.',
        'selectRuntimeMode remains available so the router can persist the confirmed runtime mode.',
      ];
  }
}

function collectRuntimeModeToolNames(
  record: HostSessionRecord,
  companionFiles: Readonly<Record<string, string>>,
): {
  readonly availableToolNames: readonly string[];
  readonly usedToolNames: readonly string[];
  readonly hasAvailableToolsSnapshot: boolean;
} {
  const availableToolNames = new Set<string>();
  const usedToolNames = new Set<string>();
  let hasAvailableToolsSnapshot = false;

  for (const [fileName, content] of Object.entries(companionFiles)) {
    if (!fileName.startsWith('tools_')) {
      continue;
    }

    hasAvailableToolsSnapshot = true;
    for (const toolName of extractToolNamesFromToolsContent(content)) {
      availableToolNames.add(toolName);
    }
  }

  for (const turn of record.turnResponses ?? []) {
    for (const round of turn.rounds ?? []) {
      for (const toolCall of round.toolCalls ?? []) {
        const toolName = normalizeToolName(toolCall.toolName || toolCall.id);
        if (toolName) {
          usedToolNames.add(toolName);
        }
      }
    }
  }

  return {
    availableToolNames: [...availableToolNames].sort(),
    usedToolNames: [...usedToolNames].sort(),
    hasAvailableToolsSnapshot,
  };
}

function extractToolNamesFromToolsContent(content: string): string[] {
  const toolNames = new Set<string>();
  try {
    collectToolNamesFromParsedValue(JSON.parse(content), toolNames);
  } catch {
    collectToolNamesFromText(content, toolNames);
  }
  return [...toolNames].sort();
}

function collectToolNamesFromParsedValue(value: unknown, toolNames: Set<string>, parentKey = ''): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    const normalized = normalizeToolName(value);
    if (normalized && isToolNameKey(parentKey)) {
      toolNames.add(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectToolNamesFromParsedValue(item, toolNames, parentKey));
    return;
  }

  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      collectToolNamesFromParsedValue(item, toolNames, key);
    });
  }
}

function collectToolNamesFromText(content: string, toolNames: Set<string>): void {
  const patterns = [
    /"(?:name|toolName|tool_name)"\s*:\s*"([^"]+)"/g,
    /\b(?:name|toolName|tool_name)\s*[:=]\s*([A-Za-z_][\w-]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const toolName = normalizeToolName(match[1]);
      if (toolName) {
        toolNames.add(toolName);
      }
    }
  }
}

function isToolNameKey(key: string): boolean {
  return key === 'name' || key === 'toolName' || key === 'tool_name';
}

function normalizeToolName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z_][\w-]*$/.test(value.trim())
    ? value.trim()
    : null;
}

function formatRuntimeModeDebugDetails(summary: HostSessionRuntimeModeDebugSummary): string {
  return [
    `runtimeMode: ${summary.runtimeMode}`,
    `runtimeModeSource: ${summary.runtimeModeSource}`,
    ...(summary.developmentModePreference
      ? [
        `developmentModePreference: ${summary.developmentModePreference.preference}`,
        `developmentModePreferenceSource: ${summary.developmentModePreference.source ?? 'unset'}`,
      ]
      : []),
    `promptProfileId: ${summary.promptProfileId}`,
    `promptSectionIds: ${formatList(summary.promptSectionIds)}`,
    `toolFiltering: ${summary.toolFiltering.join(' | ')}`,
    `availableToolNames: ${summary.hasAvailableToolsSnapshot ? formatList(summary.availableToolNames) : 'unavailable'}`,
    `usedToolNames: ${formatList(summary.usedToolNames)}`,
    ...(summary.warnings.length > 0
      ? [`warnings: ${summary.warnings.join(' | ')}`]
      : ['warnings: none']),
  ].join('\n');
}

function formatSessionScopeDebugDetails(summary: HostSessionScopeDebugSummary): string {
  return [
    `sessionScopeKind: ${summary.sessionScopeKind}`,
    `sessionProjectPath: ${summary.sessionProjectPath ?? 'none'}`,
    `listScopeKey: ${summary.listScopeKey}`,
    `storagePath: ${summary.storagePath ?? 'unavailable'}`,
    `metadataProjectPath: ${summary.metadataProjectPath ?? 'none'}`,
    `entryProjectPath: ${summary.entryProjectPath ?? 'none'}`,
    ...(summary.notes?.length ? summary.notes.map(note => `note: ${note}`) : []),
  ].join('\n');
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function formatContextUsageDetails(summary: HostSessionDebugContextUsageSummary): string {
  const lines = [
    `usageSource: ${summary.usageSource}`,
    `promptTokens: ${summary.promptTokens}`,
    `completionTokens: ${summary.completionTokens}`,
    `usedTokens: ${summary.usedTokens}`,
  ];
  if (typeof summary.outputBuffer === 'number') {
    lines.push(`outputBuffer: ${summary.outputBuffer}`);
  }
  return lines.join('\n');
}

function formatRestoreDiagnosticsDetails(summary: HostSessionRestoreDiagnosticsSummary): string {
  const lines = [
    `session: ${summary.sessionId}`,
    `lex snapshot: ${summary.lexSnapshotPath}`,
    `storedSnapshotState: ${summary.storedSnapshotState}`,
    ...(summary.storedSnapshotError ? [`storedSnapshotError: ${summary.storedSnapshotError}`] : []),
    ...(summary.missingActiveSkillNames?.length
      ? [`missingActiveSkillNames: ${summary.missingActiveSkillNames.join(', ')}`]
      : []),
    ...(summary.notes?.length ? summary.notes.map(note => `note: ${note}`) : []),
  ];
  return lines.join('\n');
}

function formatRestoreFailureDetails(summary: HostSessionRestoreFailureSummary): string {
  const lines = [
    `session: ${summary.sessionId}`,
    `stage: ${summary.stage}`,
    `projectPath: ${summary.projectPath ?? 'unknown'}`,
    `requestSource: ${summary.requestSource}`,
    `hostRecordSource: ${summary.hostRecordSource}`,
    `metadataSource: ${summary.metadataSource}`,
    ...(summary.restoreKind ? [`restoreKind: ${summary.restoreKind}`] : []),
    ...(summary.hostRecordSessionId ? [`hostRecordSessionId: ${summary.hostRecordSessionId}`] : []),
    ...(summary.storedSnapshotState ? [`storedSnapshotState: ${summary.storedSnapshotState}`] : []),
    `errorMessage: ${summary.errorMessage}`,
    ...(summary.notes?.length ? summary.notes.map(note => `note: ${note}`) : []),
  ];
  return lines.join('\n');
}

function attachCompanionFileRefsToDebugEvents(
  events: readonly HostSessionDebugEvent[],
  refsByTurnId: ReadonlyMap<string, { readonly systemPromptFile?: string; readonly toolsFile?: string }>,
): HostSessionDebugEvent[] {
  return events.map(event => {
    if (event.kind !== 'modelTurn') {
      return event;
    }

    const refs = refsByTurnId.get(event.turnId);
    if (!refs?.systemPromptFile && !refs?.toolsFile) {
      return event;
    }

    return {
      ...event,
      ...(refs.systemPromptFile ? { systemPromptFile: refs.systemPromptFile } : {}),
      ...(refs.toolsFile ? { toolsFile: refs.toolsFile } : {}),
    };
  });
}

function buildHostSessionDebugCompanionBundle(
  record: HostSessionRecord,
): {
  readonly companionFiles: Record<string, string>;
  readonly refsByTurnId: ReadonlyMap<string, { readonly systemPromptFile?: string; readonly toolsFile?: string }>;
} {
  const companionFiles: Record<string, string> = {};
  const refsByTurnId = new Map<string, { readonly systemPromptFile?: string; readonly toolsFile?: string }>();
  let currentSystemContent: string | undefined;
  let currentSystemPromptFile: string | undefined;
  let currentToolsContent: string | undefined;
  let currentToolsFile: string | undefined;
  let systemPromptIndex = 0;
  let toolsIndex = 0;

  for (const turn of record.turnResponses ?? []) {
    const artifacts = readTurnRequestDebugArtifactsSnapshot(turn.request?.metadata);
    const systemArtifactContent = artifacts?.find(artifact => artifact.kind === 'system')?.content;
    const toolsArtifactContent = artifacts?.find(artifact => artifact.kind === 'tools')?.content;
    const systemContent = typeof systemArtifactContent === 'string' && systemArtifactContent.length > 0
      ? systemArtifactContent
      : undefined;
    const toolsContent = typeof toolsArtifactContent === 'string' && toolsArtifactContent.length > 0
      ? toolsArtifactContent
      : undefined;
    const refs: { systemPromptFile?: string; toolsFile?: string } = {};

    if (systemContent) {
      if (systemContent !== currentSystemContent || !currentSystemPromptFile) {
        currentSystemContent = systemContent;
        currentSystemPromptFile = `system_prompt_${systemPromptIndex}.json`;
        systemPromptIndex += 1;
        companionFiles[currentSystemPromptFile] = systemContent;
      }
      refs.systemPromptFile = currentSystemPromptFile;
    } else {
      currentSystemContent = undefined;
      currentSystemPromptFile = undefined;
    }

    if (toolsContent) {
      if (toolsContent !== currentToolsContent || !currentToolsFile) {
        currentToolsContent = toolsContent;
        currentToolsFile = `tools_${toolsIndex}.json`;
        toolsIndex += 1;
        companionFiles[currentToolsFile] = toolsContent;
      }
      refs.toolsFile = currentToolsFile;
    } else {
      currentToolsContent = undefined;
      currentToolsFile = undefined;
    }

    if (refs.systemPromptFile || refs.toolsFile) {
      refsByTurnId.set(turn.turnId, refs);
    }
  }

  return {
    companionFiles,
    refsByTurnId,
  };
}

function countRecordMessages(record: HostSessionRecord): number {
  return record.turnResponses?.length ? record.turnResponses.length * 2 : 0;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneJsonValue(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, cloneJsonValue(entryValue)]),
    ) as T;
  }

  return value;
}

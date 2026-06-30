import type { SessionSnapshot } from 'aily-lex/browser';

import type {
  HostSessionRecord,
  HostSessionRuntimeAuxiliary,
  HostSessionSkillInvocationTraceEntry,
  SessionMetadata,
} from '../services/chat-history.service';
import type { PendingFollowupRequest } from './chat-pending-request';
import { cloneSessionRequestContextSnapshot } from './turn-request-prompt-context';

type SessionRequestContextSnapshot = NonNullable<SessionSnapshot['requestContext']>;

export function cloneHostSessionRuntimeAuxiliary(
  auxiliary: Partial<HostSessionRuntimeAuxiliary> | null | undefined,
): HostSessionRuntimeAuxiliary | undefined {
  if (!auxiliary) {
    return undefined;
  }

  const requestContext = cloneSessionRequestContextSnapshot(auxiliary.requestContext);
  const activeSkillNames = normalizeActiveSkillNames(auxiliary.activeSkillNames);
  const skillInvocationTrace = normalizeSkillInvocationTrace(auxiliary.skillInvocationTrace);
  const pendingFollowupRequests = clonePendingFollowupRequests(auxiliary.pendingFollowupRequests);
  const yieldRequested = auxiliary.yieldRequested === true;
  const hasExplicitActiveSkillNames = Array.isArray(auxiliary.activeSkillNames);
  if (!requestContext
    && !hasExplicitActiveSkillNames
    && !skillInvocationTrace
    && !pendingFollowupRequests?.length
    && !yieldRequested) {
    return undefined;
  }

  return {
    ...(requestContext ? { requestContext } : {}),
    ...(hasExplicitActiveSkillNames ? { activeSkillNames: activeSkillNames ?? [] } : {}),
    ...(skillInvocationTrace ? { skillInvocationTrace } : {}),
    ...(pendingFollowupRequests?.length ? { pendingFollowupRequests } : {}),
    ...(yieldRequested ? { yieldRequested: true } : {}),
  };
}

export function resolveHostSessionRuntimeAuxiliary(
  record: Pick<HostSessionRecord, 'auxiliary' | 'metadata'>,
): HostSessionRuntimeAuxiliary | undefined {
  return cloneHostSessionRuntimeAuxiliary(
    record.auxiliary ?? {
      requestContext: record.metadata.requestContext,
      activeSkillNames: record.metadata.activeSkillNames,
    },
  );
}

export function resolveHostSessionRequestContext(
  record: Pick<HostSessionRecord, 'auxiliary' | 'metadata'>,
): SessionRequestContextSnapshot | undefined {
  return resolveHostSessionRuntimeAuxiliary(record)?.requestContext;
}

export function resolveHostSessionActiveSkillNames(
  record: Pick<HostSessionRecord, 'auxiliary' | 'metadata'>,
): readonly string[] | undefined {
  return resolveHostSessionRuntimeAuxiliary(record)?.activeSkillNames;
}

export function stripLegacyRuntimeAuxiliaryFromMetadata<T extends Partial<SessionMetadata>>(metadata: T): T {
  const { requestContext: _requestContext, activeSkillNames: _activeSkillNames, ...rest } = metadata;
  return rest as T;
}

function normalizeActiveSkillNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(entry => entry.trim()),
  )).sort((left, right) => left.localeCompare(right));
}

function normalizeSkillInvocationTrace(value: unknown): HostSessionSkillInvocationTraceEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .map(entry => normalizeSkillInvocationTraceEntry(entry))
    .filter((entry): entry is HostSessionSkillInvocationTraceEntry => !!entry);
  if (entries.length === 0) {
    return undefined;
  }

  const deduped = new Map<string, HostSessionSkillInvocationTraceEntry>();
  for (const entry of entries) {
    deduped.set(entry.toolCallId, entry);
  }
  return [...deduped.values()];
}

function normalizeSkillInvocationTraceEntry(value: unknown): HostSessionSkillInvocationTraceEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as {
    toolCallId?: unknown;
    name?: unknown;
    skillUri?: unknown;
    mode?: unknown;
    scope?: unknown;
    relatedFiles?: unknown;
  };
  const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const skillUri = typeof record.skillUri === 'string' ? record.skillUri.trim() : '';
  if (!toolCallId || !name || !skillUri) {
    return null;
  }

  const relatedFiles = Array.isArray(record.relatedFiles)
    ? record.relatedFiles
      .map(file => normalizeSkillInvocationTraceFile(file))
      .filter((file): file is HostSessionSkillInvocationTraceEntry['relatedFiles'][number] => !!file)
    : [];

  return {
    toolCallId,
    name,
    skillUri,
    mode: record.mode === 'fork' ? 'fork' : 'inline',
    scope: record.scope === 'session' ? 'session' : 'request',
    relatedFiles,
  };
}

function normalizeSkillInvocationTraceFile(
  value: unknown,
): HostSessionSkillInvocationTraceEntry['relatedFiles'][number] | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as { path?: unknown; uri?: unknown; category?: unknown };
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const uri = typeof record.uri === 'string' ? record.uri.trim() : '';
  if (!path || !uri) {
    return null;
  }

  return {
    path,
    uri,
    ...(typeof record.category === 'string' && record.category.trim().length > 0
      ? { category: record.category.trim() }
      : {}),
  };
}

function clonePendingFollowupRequests(value: unknown): readonly PendingFollowupRequest[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  try {
    return globalThis.structuredClone(value) as readonly PendingFollowupRequest[];
  } catch {
    return JSON.parse(JSON.stringify(value)) as readonly PendingFollowupRequest[];
  }
}
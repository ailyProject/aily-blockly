import {
  CHAT_SESSION_PERMISSION_MODES,
  normalizeChatModeId,
  type ChatModeId,
  type ChatSessionPermissionMode,
} from '../core/chat-mode';
import {
  CHAT_AGENT_RUNTIME_MODES,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';

export type HostSessionTurnAgentRole = 'main' | 'subagent';

export interface HostSessionTurnRuntimeTruth {
  readonly chatMode?: ChatModeId;
  readonly runtimeMode?: ChatAgentRuntimeMode;
  readonly runtimeSource?: ChatAgentRuntimeModeSource;
  readonly agentRole?: HostSessionTurnAgentRole;
  readonly permissionMode?: ChatSessionPermissionMode;
  readonly projectPath?: string | null;
}

export function buildHostSessionTurnRuntimeTruth(input: {
  readonly chatMode?: unknown;
  readonly runtimeMode?: unknown;
  readonly runtimeSource?: unknown;
  readonly agentRole?: unknown;
  readonly permissionMode?: unknown;
  readonly projectPath?: unknown;
}): HostSessionTurnRuntimeTruth | undefined {
  return normalizeHostSessionTurnRuntimeTruth(input);
}

export function readHostSessionTurnRuntimeTruthFromMetadata(
  metadata: unknown,
): HostSessionTurnRuntimeTruth | undefined {
  const record = asRecord(metadata);
  return normalizeHostSessionTurnRuntimeTruth(record?.['runtimeTruth']);
}

export function normalizeHostSessionTurnRuntimeTruth(
  value: unknown,
): HostSessionTurnRuntimeTruth | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const chatMode = normalizeOptionalChatModeId(record['chatMode']);
  const runtimeMode = normalizeOptionalRuntimeMode(record['runtimeMode']);
  const runtimeSource = normalizeOptionalRuntimeSource(record['runtimeSource']);
  const agentRole = normalizeOptionalAgentRole(record['agentRole']);
  const permissionMode = normalizeOptionalPermissionMode(record['permissionMode']);
  const projectPath = normalizeOptionalProjectPath(record['projectPath']);
  if (!chatMode && !runtimeMode && !runtimeSource && !agentRole && !permissionMode && projectPath === undefined) {
    return undefined;
  }

  return {
    ...(chatMode ? { chatMode } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(projectPath !== undefined ? { projectPath } : {}),
  };
}

function normalizeOptionalChatModeId(value: unknown): ChatModeId | undefined {
  return typeof value === 'string' && value.trim()
    ? normalizeChatModeId(value)
    : undefined;
}

function normalizeOptionalRuntimeMode(value: unknown): ChatAgentRuntimeMode | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return (CHAT_AGENT_RUNTIME_MODES as readonly string[]).includes(normalized)
    ? normalized as ChatAgentRuntimeMode
    : undefined;
}

function normalizeOptionalRuntimeSource(value: unknown): ChatAgentRuntimeModeSource | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isRuntimeModeSource(normalized) ? normalized : undefined;
}

function normalizeOptionalAgentRole(value: unknown): HostSessionTurnAgentRole | undefined {
  return value === 'main' || value === 'subagent' ? value : undefined;
}

function normalizeOptionalPermissionMode(value: unknown): ChatSessionPermissionMode | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  return (CHAT_SESSION_PERMISSION_MODES as readonly string[]).includes(normalized)
    ? normalized as ChatSessionPermissionMode
    : undefined;
}

function normalizeOptionalProjectPath(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isRuntimeModeSource(value: string): value is ChatAgentRuntimeModeSource {
  return value === 'user_selected'
    || value === 'user_preference'
    || value === 'project_inferred'
    || value === 'restored'
    || value === 'router_confirmed'
    || value === 'fallback';
}

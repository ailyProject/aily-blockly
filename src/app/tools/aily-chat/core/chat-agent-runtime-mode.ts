import { AilyHost } from './host';

export const CHAT_AGENT_RUNTIME_MODES = ['unbound', 'coder', 'blockly'] as const;

export type ChatAgentRuntimeMode = typeof CHAT_AGENT_RUNTIME_MODES[number];

export type ChatAgentRuntimeModeSource =
  | 'user_selected'
  | 'user_preference'
  | 'project_inferred'
  | 'restored'
  | 'router_confirmed'
  | 'fallback';

export interface ChatAgentRuntimeModeResolution {
  readonly mode: ChatAgentRuntimeMode;
  readonly source: ChatAgentRuntimeModeSource;
  readonly reason: string;
  readonly projectPath?: string | null;
  readonly hasAbsProject?: boolean;
  readonly hasCoderEntry?: boolean;
}

export interface ChatAgentRuntimeModeMetadataLike {
  readonly agentRuntimeMode?: unknown;
  readonly runtimeMode?: unknown;
  readonly runtimeTruth?: unknown;
  readonly agentRuntimeModeSource?: unknown;
  readonly runtimeModeSource?: unknown;
  readonly promptProfileId?: unknown;
  readonly profileId?: unknown;
  readonly promptHostId?: unknown;
  readonly hostId?: unknown;
  readonly availableToolNames?: unknown;
  readonly toolNames?: unknown;
  readonly lastToolNames?: unknown;
  readonly toolCalls?: unknown;
}

export interface ChatAgentRuntimeModeResolveInput {
  readonly projectPath?: string | null;
  readonly metadata?: ChatAgentRuntimeModeMetadataLike | null;
  readonly preferredMode?: unknown;
  readonly userPreferenceMode?: unknown;
  readonly fallback?: ChatAgentRuntimeMode;
  readonly requireExistingProjectPath?: boolean;
}

export function normalizeChatAgentRuntimeMode(
  value: unknown,
  fallback: ChatAgentRuntimeMode = 'unbound',
): ChatAgentRuntimeMode {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((CHAT_AGENT_RUNTIME_MODES as readonly string[]).includes(normalized)) {
      return normalized as ChatAgentRuntimeMode;
    }
  }

  return fallback;
}

export function readChatAgentRuntimeModeFromMetadata(
  metadata: ChatAgentRuntimeModeMetadataLike | null | undefined,
): ChatAgentRuntimeMode | undefined {
  if (!metadata) {
    return undefined;
  }

  const agentRuntimeMode = normalizeOptionalChatAgentRuntimeMode(metadata.agentRuntimeMode);
  if (agentRuntimeMode) {
    return agentRuntimeMode;
  }

  const runtimeMode = normalizeOptionalChatAgentRuntimeMode(metadata.runtimeMode);
  if (runtimeMode) {
    return runtimeMode;
  }

  return normalizeOptionalChatAgentRuntimeMode(readNestedRuntimeTruthValue(metadata.runtimeTruth, 'runtimeMode'));
}

export function normalizeChatAgentRuntimeModeSource(
  value: unknown,
  fallback: ChatAgentRuntimeModeSource = 'fallback',
): ChatAgentRuntimeModeSource {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (isChatAgentRuntimeModeSource(normalized)) {
      return normalized;
    }
  }

  return fallback;
}

export function readChatAgentRuntimeModeSourceFromMetadata(
  metadata: ChatAgentRuntimeModeMetadataLike | null | undefined,
): ChatAgentRuntimeModeSource | undefined {
  if (!metadata) {
    return undefined;
  }

  const source = normalizeOptionalChatAgentRuntimeModeSource(metadata.agentRuntimeModeSource);
  if (source) {
    return source;
  }

  const runtimeModeSource = normalizeOptionalChatAgentRuntimeModeSource(metadata.runtimeModeSource);
  if (runtimeModeSource) {
    return runtimeModeSource;
  }

  return normalizeOptionalChatAgentRuntimeModeSource(readNestedRuntimeTruthValue(metadata.runtimeTruth, 'runtimeSource'));
}

export function createChatAgentRuntimeModeConfigKey(mode: ChatAgentRuntimeMode): string {
  return `agent-runtime:${mode}`;
}

export function extractChatAgentRuntimeModeFromConfigKey(
  configKey: string | null | undefined,
): ChatAgentRuntimeMode | undefined {
  if (typeof configKey !== 'string' || configKey.trim().length === 0) {
    return undefined;
  }

  const match = configKey.match(/(?:^|::)agent-runtime:([^:]+)/);
  return normalizeOptionalChatAgentRuntimeMode(match?.[1]);
}

export interface ChatAgentRuntimeModelConfigLike {
  readonly model?: unknown;
  readonly presetId?: unknown;
  readonly reasoningEffort?: unknown;
  readonly contextWindowTokens?: unknown;
  readonly providerContextManagementSupport?: unknown;
  readonly isCustom?: unknown;
  readonly baseUrl?: unknown;
  readonly apiKeyId?: unknown;
}

export function createChatAgentModelConfigKey(model: ChatAgentRuntimeModelConfigLike | null | undefined): string {
  const segment = (value: unknown, fallback = ''): string => {
    if (typeof value === 'string') {
      return value.trim() || fallback;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return fallback;
      }
    }
    return fallback;
  };
  const encode = (value: unknown, fallback = ''): string => encodeURIComponent(segment(value, fallback));
  return [
    'agent-model',
    `model=${encode(model?.model, 'default')}`,
    `preset=${encode(model?.presetId)}`,
    `reasoning=${encode(model?.reasoningEffort)}`,
    `context=${encode(model?.contextWindowTokens)}`,
    `custom=${encode(model?.isCustom, 'false')}`,
    `base=${encode(model?.baseUrl)}`,
    `key=${encode(model?.apiKeyId)}`,
    `context-management=${encode(model?.providerContextManagementSupport)}`,
  ].join(':');
}

export function createChatAgentRuntimeConfigKey(
  providerOptionsKey: string,
  runtimeMode: unknown,
  model?: ChatAgentRuntimeModelConfigLike | null,
): string {
  const runtimeKey = providerOptionsKey.includes('::agent-runtime:')
    ? providerOptionsKey
    : `${providerOptionsKey}::${createChatAgentRuntimeModeConfigKey(normalizeChatAgentRuntimeMode(runtimeMode, 'unbound'))}`;
  return runtimeKey.includes('::agent-model:')
    ? runtimeKey
    : `${runtimeKey}::${createChatAgentModelConfigKey(model)}`;
}

export function resolveChatAgentRuntimeModeForProject(
  input: ChatAgentRuntimeModeResolveInput = {},
): ChatAgentRuntimeModeResolution {
  const preferredMode = normalizeOptionalChatAgentRuntimeMode(input.preferredMode);
  const userPreferenceMode = normalizeOptionalChatAgentRuntimeMode(input.userPreferenceMode);
  const projectPath = normalizeProjectPath(input.projectPath);
  const restoredMode = readChatAgentRuntimeModeFromMetadata(input.metadata);
  const restoredSource = readChatAgentRuntimeModeSourceFromMetadata(input.metadata) ?? 'restored';
  if (preferredMode) {
    return {
      mode: preferredMode,
      source: 'user_selected',
      reason: `explicit runtime mode: ${preferredMode}`,
      projectPath: projectPath ?? null,
    };
  }

  if (projectPath && input.requireExistingProjectPath && !hostPathExists(projectPath)) {
    if (userPreferenceMode && userPreferenceMode !== 'unbound') {
      return {
        mode: userPreferenceMode,
        source: 'user_preference',
        reason: `restored project path missing; user preference: ${userPreferenceMode}`,
        projectPath,
      };
    }

    return {
      mode: 'unbound',
      source: 'fallback',
      reason: 'restored project path missing',
      projectPath,
    };
  }

  if (restoredMode && restoredMode !== 'unbound') {
    return {
      mode: restoredMode,
      source: restoredSource,
      reason: `restored runtime mode: ${restoredMode}`,
      projectPath: projectPath ?? null,
    };
  }

  if (projectPath) {
    const hasAbsProject = hostPathExists(projectPath, 'project.abs');
    const hasCoderEntry = hostPathExists(projectPath, 'src', 'main.cpp');

    if (hasAbsProject && hasCoderEntry) {
      const metadataHintMode = restoredMode && restoredMode !== 'unbound'
        ? restoredMode
        : readRuntimeModeHintFromMetadata(input.metadata);
      if (metadataHintMode && metadataHintMode !== 'unbound') {
        return {
          mode: metadataHintMode,
          source: 'project_inferred',
          reason: `ambiguous runtime markers resolved by metadata hint: ${metadataHintMode}`,
          projectPath,
          hasAbsProject,
          hasCoderEntry,
        };
      }

      return {
        mode: 'unbound',
        source: 'fallback',
        reason: 'ambiguous runtime markers detected',
        projectPath,
        hasAbsProject,
        hasCoderEntry,
      };
    }

    if (hasAbsProject) {
      return {
        mode: 'blockly',
        source: 'project_inferred',
        reason: userPreferenceMode && userPreferenceMode !== 'blockly'
          ? `project.abs detected; user preference ignored: ${userPreferenceMode}`
          : 'project.abs detected',
        projectPath,
        hasAbsProject,
        hasCoderEntry,
      };
    }

    if (hasCoderEntry) {
      return {
        mode: 'coder',
        source: 'project_inferred',
        reason: userPreferenceMode && userPreferenceMode !== 'coder'
          ? `src/main.cpp detected; user preference ignored: ${userPreferenceMode}`
          : 'src/main.cpp detected',
        projectPath,
        hasAbsProject,
        hasCoderEntry,
      };
    }
  }

  if (userPreferenceMode && userPreferenceMode !== 'unbound') {
    return {
      mode: userPreferenceMode,
      source: 'user_preference',
      reason: projectPath
        ? `no runtime marker detected; user preference: ${userPreferenceMode}`
        : `no project selected; user preference: ${userPreferenceMode}`,
      projectPath: projectPath ?? null,
    };
  }

  const fallback = input.fallback ?? 'unbound';
  return {
    mode: restoredMode ?? fallback,
    source: restoredMode ? restoredSource : 'fallback',
    reason: restoredMode
      ? `restored runtime mode: ${restoredMode}`
      : projectPath
        ? 'no runtime marker detected'
        : 'no project selected',
    projectPath: projectPath ?? null,
  };
}

function readNestedRuntimeTruthValue(value: unknown, key: 'runtimeMode' | 'runtimeSource'): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function normalizeOptionalChatAgentRuntimeMode(value: unknown): ChatAgentRuntimeMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return (CHAT_AGENT_RUNTIME_MODES as readonly string[]).includes(normalized)
    ? normalized as ChatAgentRuntimeMode
    : undefined;
}

function normalizeOptionalChatAgentRuntimeModeSource(value: unknown): ChatAgentRuntimeModeSource | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return isChatAgentRuntimeModeSource(normalized)
    ? normalized
    : undefined;
}

function isChatAgentRuntimeModeSource(value: string): value is ChatAgentRuntimeModeSource {
  return value === 'user_selected'
    || value === 'user_preference'
    || value === 'project_inferred'
    || value === 'restored'
    || value === 'router_confirmed'
    || value === 'fallback';
}

function normalizeProjectPath(projectPath: string | null | undefined): string | null {
  return typeof projectPath === 'string' && projectPath.trim().length > 0
    ? projectPath.trim()
    : null;
}

function readRuntimeModeHintFromMetadata(
  metadata: ChatAgentRuntimeModeMetadataLike | null | undefined,
): ChatAgentRuntimeMode | undefined {
  if (!metadata) {
    return undefined;
  }

  const values: string[] = [];
  appendMetadataHintValues(metadata.promptProfileId, values);
  appendMetadataHintValues(metadata.profileId, values);
  appendMetadataHintValues(metadata.promptHostId, values);
  appendMetadataHintValues(metadata.hostId, values);
  appendMetadataHintValues(metadata.availableToolNames, values);
  appendMetadataHintValues(metadata.toolNames, values);
  appendMetadataHintValues(metadata.lastToolNames, values);
  appendMetadataHintValues(metadata.toolCalls, values);

  const hintText = values.join('\n').toLowerCase();
  if (!hintText) {
    return undefined;
  }

  const blocklyScore = scoreRuntimeHint(hintText, [
    'blockly',
    'project.abs',
    'syncabs',
    'analyzelibrary',
    'blockly-workspace',
    'blockly-legacy',
    'runtime:blockly',
  ]);
  const coderScore = scoreRuntimeHint(hintText, [
    'coder',
    'src/main.cpp',
    'main.cpp',
    'runtime:coder',
  ]);

  if (blocklyScore > coderScore) {
    return 'blockly';
  }
  if (coderScore > blocklyScore) {
    return 'coder';
  }

  return undefined;
}

function appendMetadataHintValues(value: unknown, values: string[], depth = 0): void {
  if (depth > 3 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      values.push(text);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => appendMetadataHintValues(item, values, depth + 1));
    return;
  }

  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => {
      appendMetadataHintValues(item, values, depth + 1);
    });
  }
}

function scoreRuntimeHint(text: string, signals: readonly string[]): number {
  return signals.reduce((score, signal) => (
    text.includes(signal) ? score + 1 : score
  ), 0);
}

function hostPathExists(projectPath: string, ...segments: string[]): boolean {
  try {
    const host = AilyHost.get();
    const fullPath = host.path.join(projectPath, ...segments);
    return host.fs.existsSync(fullPath);
  } catch {
    return false;
  }
}

import {
  normalizeChatSelectedMode,
  type ChatSelectedMode,
} from '../core/chat-mode';
import {
  chatSessionScopeProjectPath,
  createGlobalChatSessionScope,
  createProjectChatSessionScope,
  type ChatSessionScope,
} from '../core/chat-session-scope';
import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import {
  normalizeHostSessionProviderOptions,
  type HostSessionProviderOptions,
} from './host-session-input-state';

export interface RequiredSessionResourceModelInput {
  readonly sessionResource: string;
  readonly projectPath?: string | null;
  readonly projectRootPath?: string | null;
  readonly selectedMode?: ChatSelectedMode | null;
  readonly runtimeMode?: unknown;
  readonly runtimeModeSource?: unknown;
  readonly providerOptions?: Partial<HostSessionProviderOptions> | null;
  readonly requiredContextSnapshot?: unknown;
  readonly checkpointNamespace?: string | null;
}

export interface RequiredSessionResourceModel {
  readonly sessionResource: string;
  readonly sessionScope: ChatSessionScope['kind'];
  readonly projectPath: string | null;
  readonly projectRootPath: string | null;
  readonly selectedMode: ChatSelectedMode;
  readonly runtimeMode: ChatAgentRuntimeMode;
  readonly runtimeModeSource: ChatAgentRuntimeModeSource;
  readonly providerOptions: HostSessionProviderOptions;
  readonly requiredContextSnapshot?: unknown;
  readonly checkpointNamespace: string;
}

export function createRequiredSessionResourceModel(
  input: RequiredSessionResourceModelInput,
): RequiredSessionResourceModel {
  const sessionResource = typeof input.sessionResource === 'string'
    ? input.sessionResource.trim()
    : '';
  if (!sessionResource) {
    throw new Error('RequiredSessionResourceModel requires a sessionResource');
  }

  const scope = input.projectPath
    ? createProjectChatSessionScope(input.projectPath, input.projectRootPath)
    : createGlobalChatSessionScope(input.projectRootPath);
  const projectPath = chatSessionScopeProjectPath(scope);
  const providerOptions = normalizeHostSessionProviderOptions({
    ...(input.providerOptions ?? {}),
    folderPath: projectPath,
  });

  return {
    sessionResource,
    sessionScope: scope.kind,
    projectPath,
    projectRootPath: scope.projectRootPath,
    selectedMode: normalizeChatSelectedMode(input.selectedMode ?? undefined),
    runtimeMode: normalizeChatAgentRuntimeMode(input.runtimeMode),
    runtimeModeSource: normalizeChatAgentRuntimeModeSource(input.runtimeModeSource),
    providerOptions,
    ...(input.requiredContextSnapshot !== undefined
      ? { requiredContextSnapshot: input.requiredContextSnapshot }
      : {}),
    checkpointNamespace: normalizeCheckpointNamespace(input.checkpointNamespace, sessionResource),
  };
}

function normalizeCheckpointNamespace(value: string | null | undefined, sessionResource: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || `refs/sessions/${sessionResource}`;
}

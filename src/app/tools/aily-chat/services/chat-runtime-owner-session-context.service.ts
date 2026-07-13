import { Injectable, inject } from '@angular/core';

import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  resolveChatAgentRuntimeModeForProject,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import {
  DEFAULT_CHAT_SESSION_TYPE,
  type ChatSelectedMode,
  normalizeChatSelectedMode,
} from '../core/chat-mode';
import {
  buildHostSessionCurrentPickerInputState,
  normalizeHostSessionProviderOptions,
  type HostSessionProviderOptions,
} from '../helpers/host-session-input-state';
import { buildHostSessionCurrentPickerRoutingSummary } from '../helpers/host-session-request-routing';
import { readChatRuntimeWorkspaceEnvironment } from '../core/chat-runtime-workspace-environment';
import { ChatSessionEntryStateService } from './chat-session-entry-state.service';
import {
  resolveChatSessionRuntimeCapabilities,
  resolveChatSessionRuntimeConcurrencyScope,
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeCapabilities,
} from './chat-session-runtime-store.service';
import {
  CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER,
  type ChatRuntimeOwnerRuntimeControllerPort,
  type ChatRuntimeOwnerSessionContextPort,
} from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSessionContextService implements ChatRuntimeOwnerSessionContextPort {
  private readonly chatSessionEntryStateService = inject(ChatSessionEntryStateService);
  private readonly runtimeController = inject<ChatRuntimeOwnerRuntimeControllerPort>(CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER);

  get prjPath(): string {
    return this.resolveCurrentSessionProviderFolderPath() ?? readChatRuntimeWorkspaceEnvironment().projectPath;
  }

  get prjRootPath(): string {
    const workspaceEnvironment = readChatRuntimeWorkspaceEnvironment();
    return workspaceEnvironment.projectRootPath
      || this.resolveCurrentSessionProviderFolderPath()
      || workspaceEnvironment.projectPath;
  }

  get currentModel(): any {
    const currentModel = this.readCurrentRuntimeState()?.currentModel;
    return currentModel && typeof currentModel === 'object'
      ? { ...(currentModel as Record<string, unknown>) }
      : null;
  }

  get currentAgentRuntimeMode(): ChatAgentRuntimeMode {
    return this.resolveCurrentRuntimeMode().mode;
  }

  get currentAgentRuntimeModeSource(): ChatAgentRuntimeModeSource {
    return this.resolveCurrentRuntimeMode().source;
  }

  get sessionTitle(): string {
    return this.readCurrentRuntimeState()?.liveMetadata?.title ?? '';
  }

  get currentSessionId(): string {
    return this.resolveCurrentRuntimeSessionId();
  }

  currentSessionPath(sessionId?: string | null): string | null {
    return this.resolveRuntimeSessionProviderOptions(sessionId).folderPath ?? null;
  }

  currentSessionPermissionMode(sessionId?: string | null): HostSessionProviderOptions['permissionMode'] {
    return this.resolveRuntimeSessionProviderOptions(sessionId).permissionMode;
  }

  currentSessionPermissionProfile(sessionId?: string | null): HostSessionProviderOptions['permissionProfile'] {
    return this.resolveRuntimeSessionProviderOptions(sessionId).permissionProfile;
  }

  currentSessionApprovalsReviewer(sessionId?: string | null): HostSessionProviderOptions['approvalsReviewer'] {
    return this.resolveRuntimeSessionProviderOptions(sessionId).approvalsReviewer;
  }

  currentSessionApprovalPolicy(sessionId?: string | null): HostSessionProviderOptions['approvalPolicy'] {
    return this.resolveRuntimeSessionProviderOptions(sessionId).approvalPolicy;
  }

  selectAgentRuntimeMode(
    mode: ChatAgentRuntimeMode | string | null | undefined,
    source: ChatAgentRuntimeModeSource | string | null | undefined = 'user_selected',
    reason?: string | null,
    sessionId?: string | null,
  ): void {
    const normalizedMode = normalizeChatAgentRuntimeMode(mode, this.currentAgentRuntimeMode);
    const normalizedSource = normalizeChatAgentRuntimeModeSource(source, 'user_selected');
    this.syncSessionEntryTargetRuntimeMode(sessionId, normalizedMode, normalizedSource);
  }

  updateRuntimeProjectPath(
    projectPath: string | null | undefined,
    sessionId?: string | null,
  ): void {
    const normalizedProjectPath = this.normalizeProjectPath(projectPath);
    const targetSessionId = this.normalizeSessionId(sessionId) || this.resolveCurrentRuntimeSessionId();
    if (!targetSessionId || !normalizedProjectPath) {
      return;
    }

    const existingProviderOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    const providerOptions = normalizeHostSessionProviderOptions({
      ...existingProviderOptions,
      folderPath: normalizedProjectPath,
    });
    const selectedMode = this.resolveRuntimeSelectedMode(targetSessionId);
    const runtimeMode = this.currentAgentRuntimeMode;
    const runtimeModeSource = this.currentAgentRuntimeModeSource;
    this.runtimeController.projectRuntimeState(targetSessionId, {
      providerOptions,
      selectedMode,
      debugSummary: {
        providerOptionsPresent: true,
        selectedModePresent: true,
      },
    });
    this.chatSessionEntryStateService.setSessionEntryTarget({
      sessionId: targetSessionId,
      projectPath: normalizedProjectPath,
      providerOptions,
      inputState: buildHostSessionCurrentPickerInputState(selectedMode, providerOptions),
      mode: selectedMode.modeId,
      agentRuntimeMode: runtimeMode,
      agentRuntimeModeSource: runtimeModeSource,
      requestRouting: buildHostSessionCurrentPickerRoutingSummary(
        selectedMode,
        undefined,
        providerOptions.permissionLevel,
        providerOptions.approvalsReviewer,
        providerOptions.approvalPolicy,
      ),
    }, normalizedProjectPath);
  }

  resolveRuntimeSessionProviderOptions(sessionId?: string | null): HostSessionProviderOptions {
    const targetSessionId = this.normalizeSessionId(sessionId);
    const runtimeProviderOptions = targetSessionId
      ? this.runtimeController.readRuntimeState(targetSessionId)?.providerOptions
      : undefined;
    if (runtimeProviderOptions) {
      return normalizeHostSessionProviderOptions(runtimeProviderOptions);
    }

    return normalizeHostSessionProviderOptions(undefined);
  }

  resolveRuntimeSelectedMode(sessionId?: string | null): ChatSelectedMode {
    const targetSessionId = this.normalizeSessionId(sessionId);
    const runtimeSelectedMode = targetSessionId
      ? this.runtimeController.readRuntimeState(targetSessionId)?.selectedMode
      : undefined;
    if (runtimeSelectedMode) {
      return normalizeChatSelectedMode(runtimeSelectedMode);
    }

    return normalizeChatSelectedMode(undefined);
  }

  resolveRuntimeCapabilities(sessionId?: string | null): ChatSessionRuntimeCapabilities {
    return resolveChatSessionRuntimeCapabilities(this.resolveRuntimeCapabilityOwner(sessionId));
  }

  resolveRuntimeConcurrencyScope(sessionId?: string | null): string | undefined {
    return resolveChatSessionRuntimeConcurrencyScope(this.resolveRuntimeCapabilityOwner(sessionId));
  }

  private resolveRuntimeCapabilityOwner(sessionId?: string | null): {
    readonly sessionType?: unknown;
    readonly providerTarget?: unknown;
    readonly remoteProviderHandle?: unknown;
    readonly customAgentTarget?: unknown;
    readonly customModeSource?: unknown;
    readonly sessionCustomizationProviderLabel?: unknown;
    readonly sessionCustomizationProviderIconId?: unknown;
  } {
    const targetSessionId = this.normalizeSessionId(sessionId);
    const providerOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    const selectedMode = this.resolveRuntimeSelectedMode(targetSessionId);

    return {
      sessionType: DEFAULT_CHAT_SESSION_TYPE,
      providerTarget: providerOptions.folderPath,
      customAgentTarget: selectedMode.customAgentTarget,
    };
  }

  private syncSessionEntryTargetRuntimeMode(
    sessionId: string | null | undefined,
    agentRuntimeMode: ChatAgentRuntimeMode,
    agentRuntimeModeSource: ChatAgentRuntimeModeSource,
  ): void {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return;
    }

    const providerOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    const selectedMode = this.resolveRuntimeSelectedMode(targetSessionId);
    const projectPath = providerOptions.folderPath ?? null;
    this.runtimeController.projectRuntimeState(targetSessionId, {
      agentRuntimeMode,
      agentRuntimeModeSource,
      debugSummary: {
        agentRuntimeModePresent: true,
      },
    });
    this.chatSessionEntryStateService.setSessionEntryTarget({
      sessionId: targetSessionId,
      projectPath,
      providerOptions,
      inputState: buildHostSessionCurrentPickerInputState(selectedMode, providerOptions),
      mode: selectedMode.modeId,
      agentRuntimeMode,
      agentRuntimeModeSource,
      requestRouting: buildHostSessionCurrentPickerRoutingSummary(
        selectedMode,
        undefined,
        providerOptions.permissionLevel,
        providerOptions.approvalsReviewer,
        providerOptions.approvalPolicy,
      ),
    }, projectPath);
  }

  private normalizeSessionId(sessionId: unknown): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private normalizeProjectPath(projectPath: unknown): string {
    return typeof projectPath === 'string' && projectPath.trim().length > 0
      ? projectPath.trim()
      : '';
  }

  private resolveCurrentRuntimeSessionId(): string {
    const sessionIds = this.runtimeController.getSessionIds();
    for (let index = sessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.normalizeSessionId(sessionIds[index]);
      if (sessionId) {
        return sessionId;
      }
    }
    return '';
  }

  private readCurrentRuntimeState(): ChatSessionRuntimeState | null {
    const sessionId = this.resolveCurrentRuntimeSessionId();
    return sessionId ? this.runtimeController.readRuntimeState(sessionId) : null;
  }

  private resolveCurrentSessionProviderFolderPath(): string | null {
    const folderPath = this.readCurrentRuntimeState()?.providerOptions?.folderPath;
    return typeof folderPath === 'string' && folderPath.trim().length > 0
      ? folderPath.trim()
      : null;
  }

  private resolveCurrentRuntimeMode(): {
    readonly mode: ChatAgentRuntimeMode;
    readonly source: ChatAgentRuntimeModeSource;
  } {
    const runtimeState = this.readCurrentRuntimeState();
    const runtimeMode = normalizeChatAgentRuntimeMode(runtimeState?.agentRuntimeMode, 'unbound');
    if (runtimeMode !== 'unbound') {
      return {
        mode: runtimeMode,
        source: normalizeChatAgentRuntimeModeSource(runtimeState?.agentRuntimeModeSource, 'restored'),
      };
    }

    const providerOptions = runtimeState?.providerOptions;
    const resolution = resolveChatAgentRuntimeModeForProject({
      projectPath: providerOptions?.folderPath ?? null,
      fallback: 'unbound',
    });
    return {
      mode: resolution.mode,
      source: resolution.source,
    };
  }
}

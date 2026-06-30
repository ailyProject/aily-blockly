import { Injectable, inject } from '@angular/core';

import { HostSessionSaveBridge, type HostSessionSaveTarget } from '../helpers/host-session-save-bridge';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import { ChatSessionModelStoreService } from './chat-session-model-store.service';
import type {
  ChatRuntimeOwnerRuntimeControllerPort,
  ChatRuntimeOwnerSaveBridgePort,
  ChatRuntimeOwnerSaveCurrentSessionInput,
  ChatRuntimeOwnerSaveTargetPort,
  ChatRuntimeOwnerSessionModelPort,
  ChatRuntimeOwnerStatePort,
} from './chat-runtime-owner-ports';
import {
  CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER,
  CHAT_RUNTIME_OWNER_SAVE_TARGET,
  CHAT_RUNTIME_OWNER_SESSION_MODEL,
  CHAT_RUNTIME_OWNER_STATE,
} from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerSaveBridgeService implements ChatRuntimeOwnerSaveBridgePort {
  private readonly chatSessionModelStore = inject(ChatSessionModelStoreService);
  private readonly runtimeController = inject<ChatRuntimeOwnerRuntimeControllerPort>(CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER);
  private readonly ownerSessionModel = inject<ChatRuntimeOwnerSessionModelPort>(CHAT_RUNTIME_OWNER_SESSION_MODEL);
  private readonly ownerState = inject<ChatRuntimeOwnerStatePort>(CHAT_RUNTIME_OWNER_STATE);
  private readonly ownerSaveTarget = inject<ChatRuntimeOwnerSaveTargetPort>(CHAT_RUNTIME_OWNER_SAVE_TARGET);

  saveCurrentSession(input: ChatRuntimeOwnerSaveCurrentSessionInput): void {
    void this.saveCurrentSessionThroughHost(input).catch(error => {
      console.error('[AilyChat][RuntimeOwnerSaveBridge] Host session save failed:', error);
    });
  }

  private async saveCurrentSessionThroughHost(input: ChatRuntimeOwnerSaveCurrentSessionInput): Promise<void> {
    const activeSessionId = this.normalizeSessionId(input.sessionId);
    const target = input.target ?? this.ownerSaveTarget.buildExecutionSaveTarget(activeSessionId);
    const saveBridge = this.createSessionSaveBridge({
      sessionId: activeSessionId,
      sessionTitle: input.sessionTitle,
      lexStream: input.lexStream,
    });

    const record = saveBridge.buildLiveHostSessionRecord({
      hostProjection: input.hostProjection ?? null,
      visibleChatList: input.visibleChatList,
      hostRequestModel: input.hostRequestModel ?? null,
      target,
    });

    if (record) {
      await this.requestHostSessionSave(activeSessionId, target, record);
      return;
    }
  }

  private createSessionSaveBridge(input: Pick<ChatRuntimeOwnerSaveCurrentSessionInput, 'sessionId' | 'sessionTitle' | 'lexStream'>): HostSessionSaveBridge {
    const service = this;
    return new HostSessionSaveBridge({
      get toolCallingIteration() { return service.ownerState.toolCallingIteration; },
      get currentMode() {
        return service.readRuntimeState(input.sessionId)?.selectedMode?.modeId ?? 'agent';
      },
      get currentAgentRuntimeMode() { return 'unbound' as const; },
      get currentAgentRuntimeModeSource() { return 'restored' as const; },
      get currentModel() { return service.readRuntimeState(input.sessionId)?.currentModel ?? null; },
      get sessionId() { return input.sessionId; },
      get sessionTitle() { return input.sessionTitle; },
      get lexStream() { return input.lexStream; },
      readCurrentViewSessionResource: () => null,
      readPersistedHostRecord: () => null,
      readSessionTurnResponses: (sessionId) => service.ownerSessionModel.readTurnResponses(sessionId),
      readSessionRuntimeState: (sessionId) => service.readRuntimeState(sessionId),
      readSessionCheckpointTimelineState: (sessionId) => {
        const targetSessionId = service.normalizeSessionId(sessionId);
        return targetSessionId
          ? service.chatSessionModelStore.get(targetSessionId)?.getCheckpointTimelineState() ?? null
          : null;
      },
    });
  }

  private async requestHostSessionSave(
    sessionId: string,
    target: HostSessionSaveTarget | null | undefined,
    record: unknown,
  ): Promise<void> {
    const normalizedSessionId = this.normalizeSessionId(sessionId || target?.sessionId);
    if (!normalizedSessionId) {
      throw new Error('[AilyChat][RuntimeOwnerSaveBridge] Cannot save a session without a host session id.');
    }

    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('[AilyChat][RuntimeOwnerSaveBridge] Electron runtime host transport is unavailable.');
    }

    await runtimeHost.requestResourceOperation({
      sessionId: normalizedSessionId,
      kind: 'save-current-session',
      label: 'Saving chat session',
      resource: {
        targetSessionId: this.normalizeSessionId(target?.sessionId) || normalizedSessionId,
        sessionType: target?.sessionType ?? null,
        projectPath: target?.providerOptions?.folderPath ?? null,
      },
      payload: {
        adapter: 'chatHistory',
        record,
      },
    });
  }

  private normalizeSessionId(sessionId: unknown): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private readRuntimeState(sessionId: unknown) {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId ? this.runtimeController.readRuntimeState(targetSessionId) ?? undefined : undefined;
  }
}

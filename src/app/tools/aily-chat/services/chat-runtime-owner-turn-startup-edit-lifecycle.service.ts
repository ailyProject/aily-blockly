import { inject, Injectable } from '@angular/core';
import { readChatRuntimeWorkspaceEnvironment } from '../core/chat-runtime-workspace-environment';
import {
  CHAT_RUNTIME_OWNER_WORKSPACE_EDIT_LIFECYCLE_RESOURCE,
  type ChatRuntimeOwnerTurnStartupEditLifecyclePort,
  type ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort,
} from './chat-runtime-owner-ports';
import type { RequestCheckpointMetadata } from './edit-checkpoint.service';
import type { ChatAgentRuntimeMode } from '../core/chat-agent-runtime-mode';

@Injectable()
export class ChatRuntimeOwnerTurnStartupEditLifecycleService implements ChatRuntimeOwnerTurnStartupEditLifecyclePort {
  private readonly workspaceEditResource = inject<ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort>(
    CHAT_RUNTIME_OWNER_WORKSPACE_EDIT_LIFECYCLE_RESOURCE,
  );

  async ensureAbsExport(
    sessionId: string | null | undefined,
    runtimeMode: ChatAgentRuntimeMode | null | undefined,
  ): Promise<void> {
    if (runtimeMode !== 'blockly') {
      return;
    }
    const projectPath = readChatRuntimeWorkspaceEnvironment().projectPath;
    if (!projectPath) {
      return;
    }
    await this.workspaceEditResource.ensureWorkspaceAbsExport(sessionId, projectPath);
  }

  saveCheckpointToDisk(sessionId: string | null | undefined): void {
    void this.workspaceEditResource.commitCurrentTurn(sessionId).catch((error: unknown) => {
      console.warn('[AilyChat][RuntimeOwner] checkpoint commit before turn failed:', error);
    });
  }

  commitCurrentTurn(sessionId: string | null | undefined): Promise<void> {
    return this.workspaceEditResource.commitCurrentTurn(sessionId);
  }

  waitForCheckpointMetadataSettled(sessionId: string | null | undefined): Promise<void> {
    return this.workspaceEditResource.waitForCheckpointMetadataSettled(sessionId);
  }

  readFinalizedCheckpointMetadata(
    sessionId: string | null | undefined,
    input: { readonly checkpointId?: string; readonly requestId?: string },
  ): Promise<RequestCheckpointMetadata | null> {
    return this.workspaceEditResource.readFinalizedCheckpointMetadata(sessionId, input);
  }
}

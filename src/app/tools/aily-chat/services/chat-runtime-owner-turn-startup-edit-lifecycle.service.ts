import { inject, Injectable } from '@angular/core';
import { readChatRuntimeWorkspaceEnvironment } from '../core/chat-runtime-workspace-environment';
import {
  CHAT_RUNTIME_OWNER_WORKSPACE_EDIT_LIFECYCLE_RESOURCE,
  type ChatRuntimeOwnerTurnStartupEditLifecyclePort,
  type ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort,
} from './chat-runtime-owner-ports';
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
}

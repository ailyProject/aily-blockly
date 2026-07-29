import { Injectable } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import {
  type ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort,
} from './chat-runtime-owner-ports';
import type { ChatRuntimeHostResourceOperationRequest } from '../core/chat-runtime-host-contract';

@Injectable()
export class ChatRuntimeOwnerWorkspaceEditLifecycleResourceService
  implements ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort {
  async ensureWorkspaceAbsExport(sessionId: string | null | undefined, projectPath: string | null | undefined): Promise<void> {
    const targetSessionId = this.requireSessionId(sessionId, 'ABS workspace export');
    const normalizedProjectPath = this.normalizeString(projectPath);
    await this.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'abs-workspace-export',
      label: 'Synchronizing Blockly workspace to ABS',
      detail: 'Workspace adapter is ensuring project.abs matches the current Blockly revision.',
      resource: {
        projectPath: normalizedProjectPath,
      },
      payload: {
        adapter: 'absAutoSync',
        action: 'ensureWorkspaceExport',
        projectPath: normalizedProjectPath,
      },
    });
  }

  private async requestHostResourceOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('[AilyChat][RuntimeOwnerResource] Electron runtime host transport is unavailable.');
    }
    return await runtimeHost.requestResourceOperation(request);
  }

  private requireSessionId(sessionId: string | null | undefined, operation: string): string {
    const normalizedSessionId = this.normalizeString(sessionId);
    if (!normalizedSessionId) {
      throw new Error(`[AilyChat][RuntimeOwnerResource] ${operation} requires a host session id.`);
    }
    return normalizedSessionId;
  }

  private normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

}

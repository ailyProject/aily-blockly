import { Injectable } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import {
  type ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort,
} from './chat-runtime-owner-ports';
import type { ChatRuntimeHostResourceOperationRequest } from '../core/chat-runtime-host-contract';
import type { RequestCheckpointMetadata } from './edit-checkpoint.service';

@Injectable()
export class ChatRuntimeOwnerWorkspaceEditLifecycleResourceService
  implements ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort {
  ensureSessionStartAbsExport(sessionId: string | null | undefined, projectPath: string | null | undefined): void {
    const targetSessionId = this.requireSessionId(sessionId, 'ABS session-start export');
    const normalizedProjectPath = this.normalizeString(projectPath);
    void this.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'abs-session-start-export',
      label: 'Scheduling ABS session-start export',
      detail: 'Workspace adapter is preparing the session-start ABS export.',
      resource: {
        projectPath: normalizedProjectPath,
      },
      payload: {
        adapter: 'absAutoSync',
        action: 'scheduleSessionStartExport',
        projectPath: normalizedProjectPath,
      },
    }).catch((error: unknown) => {
      console.warn('[AilyChat][RuntimeOwnerResource] ABS session-start export request failed:', error);
    });
  }

  async commitCurrentTurn(sessionId: string | null | undefined): Promise<void> {
    const targetSessionId = this.requireSessionId(sessionId, 'checkpoint commit');
    await this.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'checkpoint-commit',
      label: 'Committing workspace checkpoint',
      detail: 'Workspace checkpoint adapter is committing the current turn.',
      payload: {
        adapter: 'editCheckpoint',
        action: 'commitCurrentTurn',
      },
    });
  }

  async waitForCheckpointMetadataSettled(sessionId: string | null | undefined): Promise<void> {
    const targetSessionId = this.requireSessionId(sessionId, 'checkpoint settle');
    await this.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'checkpoint-settle',
      label: 'Waiting for workspace checkpoint metadata',
      detail: 'Workspace checkpoint adapter is settling checkpoint metadata before the turn continues.',
      payload: {
        adapter: 'editCheckpoint',
        action: 'settleMetadata',
      },
    });
  }

  async readFinalizedCheckpointMetadata(
    sessionId: string | null | undefined,
    input: { readonly checkpointId?: string; readonly requestId?: string },
  ): Promise<RequestCheckpointMetadata | null> {
    const targetSessionId = this.requireSessionId(sessionId, 'checkpoint metadata read');
    const result = await this.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'edit-tracking',
      label: 'Reading finalized workspace checkpoint metadata',
      detail: 'Workspace checkpoint adapter is resolving settled checkpoint metadata for the service-owned turn model.',
      payload: {
        adapter: 'editTracking',
        action: 'readFinalizedCheckpointMetadata',
        ...(this.normalizeString(input.checkpointId) ? { checkpointId: this.normalizeString(input.checkpointId) } : {}),
        ...(this.normalizeString(input.requestId) ? { requestId: this.normalizeString(input.requestId) } : {}),
      },
    });
    const metadata = this.readRecord(this.readRecord(result)?.['checkpointMetadata']);
    return metadata ? metadata as unknown as RequestCheckpointMetadata : null;
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

  private readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
}

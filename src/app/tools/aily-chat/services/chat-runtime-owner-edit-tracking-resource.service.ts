import { Injectable } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import type { ChatRuntimeHostResourceOperationRequest } from '../core/chat-runtime-host-contract';
import type { ChatRuntimeOwnerEditTrackingPort } from './chat-runtime-owner-context-capabilities';

@Injectable()
export class ChatRuntimeOwnerEditTrackingResourceService implements ChatRuntimeOwnerEditTrackingPort {
  private currentAutoSaveEdits = false;
  private currentSessionId = '';
  private operationQueue: Promise<void> = Promise.resolve();

  get autoSaveEdits(): boolean {
    return this.currentAutoSaveEdits;
  }

  set autoSaveEdits(value: boolean) {
    this.currentAutoSaveEdits = !!value;
    void this.enqueueEditTrackingOperation({
      action: 'setAutoSaveEdits',
      autoSaveEdits: this.currentAutoSaveEdits,
    }).catch(error => {
      console.warn('[AilyChat][RuntimeOwnerEditTracking] setAutoSaveEdits failed:', error);
    });
  }

  setTimelineContext(sessionId: string | null | undefined, workspaceRoot: string | null | undefined): void {
    const targetSessionId = this.requireSessionId(sessionId, 'edit tracking timeline context');
    this.currentSessionId = targetSessionId;
    void this.enqueueEditTrackingOperation({
      action: 'setTimelineContext',
      sessionId: targetSessionId,
      workspaceRoot: this.normalizeString(workspaceRoot) || null,
    }).catch(error => {
      console.warn('[AilyChat][RuntimeOwnerEditTracking] setTimelineContext failed:', error);
    });
  }

  startTurn(
    turnIndex: number,
    turnStartListIndex: number | null,
    responseStartListIndex: number | null,
    turnId?: string,
    requestContent?: string,
    displayContent?: string,
    checkpointId?: string,
    requestMetadata?: unknown,
  ): void {
    const sessionId = this.readSessionIdFromRequestMetadata(requestMetadata);
    const targetSessionId = this.requireSessionId(sessionId || this.currentSessionId, 'edit tracking start turn');
    void this.enqueueEditTrackingOperation({
      action: 'startTurn',
      sessionId: targetSessionId,
      turnIndex,
      turnStartListIndex,
      responseStartListIndex,
      turnId: this.normalizeOptionalString(turnId),
      requestContent: this.normalizeOptionalString(requestContent),
      displayContent: this.normalizeOptionalString(displayContent),
      checkpointId: this.normalizeOptionalString(checkpointId),
      requestMetadata,
      autoSaveEdits: this.currentAutoSaveEdits,
    }).catch(error => {
      console.warn('[AilyChat][RuntimeOwnerEditTracking] startTurn failed:', error);
    });
  }

  recordAdditionalRepositoryRootCandidates(paths: readonly string[] | undefined | null): void {
    const normalizedPaths = this.normalizeStringList(paths);
    if (normalizedPaths.length === 0) {
      return;
    }
    void this.enqueueEditTrackingOperation({
      action: 'recordAdditionalRepositoryRootCandidates',
      paths: normalizedPaths,
    }).catch(error => {
      console.warn('[AilyChat][RuntimeOwnerEditTracking] record repository roots failed:', error);
    });
  }

  recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void {
    const normalizedFilePath = this.normalizeString(filePath);
    if (!normalizedFilePath) {
      return;
    }
    void this.enqueueEditTrackingOperation({
      action: 'recordEdit',
      filePath: normalizedFilePath,
      editType: type,
    }).catch(error => {
      console.warn('[AilyChat][RuntimeOwnerEditTracking] recordEdit failed:', error);
    });
  }

  async publishCurrentSummary(): Promise<void> {
    await this.enqueueEditTrackingOperation({
      action: 'publishCurrentSummary',
    });
  }

  private enqueueEditTrackingOperation(
    input: Parameters<ChatRuntimeOwnerEditTrackingResourceService['requestEditTrackingOperation']>[0],
  ): Promise<void> {
    const run = this.operationQueue.then(() => this.requestEditTrackingOperation(input));
    this.operationQueue = run.catch(() => undefined);
    return run;
  }

  private async requestEditTrackingOperation(input: {
    readonly action:
      | 'setAutoSaveEdits'
      | 'setTimelineContext'
      | 'startTurn'
      | 'recordAdditionalRepositoryRootCandidates'
      | 'recordEdit'
      | 'publishCurrentSummary';
    readonly sessionId?: string;
    readonly workspaceRoot?: string | null;
    readonly turnIndex?: number;
    readonly turnStartListIndex?: number | null;
    readonly responseStartListIndex?: number | null;
    readonly turnId?: string;
    readonly requestContent?: string;
    readonly displayContent?: string;
    readonly checkpointId?: string;
    readonly requestMetadata?: unknown;
    readonly autoSaveEdits?: boolean;
    readonly paths?: readonly string[];
    readonly filePath?: string;
    readonly editType?: 'create' | 'modify' | 'delete';
  }): Promise<void> {
    const metadataSessionId = this.readSessionIdFromRequestMetadata(input.requestMetadata);
    const sessionId = this.requireSessionId(
      input.sessionId ?? (metadataSessionId || this.currentSessionId),
      `edit tracking ${input.action}`,
    );
    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('[AilyChat][RuntimeOwnerEditTracking] Electron runtime host transport is unavailable.');
    }
    const request = this.buildEditTrackingRequest(sessionId, input);
    await runtimeHost.requestResourceOperation(request);
  }

  private buildEditTrackingRequest(
    sessionId: string,
    input: Parameters<ChatRuntimeOwnerEditTrackingResourceService['requestEditTrackingOperation']>[0],
  ): ChatRuntimeHostResourceOperationRequest {
    const base = {
      sessionId,
      kind: 'edit-tracking' as const,
    };
    switch (input.action) {
      case 'setAutoSaveEdits':
        return {
          ...base,
          label: 'Updating edit tracking auto-save mode',
          payload: {
            adapter: 'editTracking',
            action: 'setAutoSaveEdits',
            autoSaveEdits: !!input.autoSaveEdits,
          },
        };
      case 'setTimelineContext':
        return {
          ...base,
          label: 'Updating edit tracking timeline context',
          resource: {
            workspaceRoot: input.workspaceRoot ?? null,
          },
          payload: {
            adapter: 'editTracking',
            action: 'setTimelineContext',
            workspaceRoot: input.workspaceRoot ?? null,
          },
        };
      case 'startTurn':
        return {
          ...base,
          label: 'Starting edit tracking turn',
          payload: {
            adapter: 'editTracking',
            action: 'startTurn',
            turnIndex: this.normalizeNumber(input.turnIndex),
            turnStartListIndex: this.normalizeNullableNumber(input.turnStartListIndex),
            responseStartListIndex: this.normalizeNullableNumber(input.responseStartListIndex),
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(input.requestContent ? { requestContent: input.requestContent } : {}),
            ...(input.displayContent ? { displayContent: input.displayContent } : {}),
            ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
            ...(input.requestMetadata !== undefined ? { requestMetadata: input.requestMetadata } : {}),
            autoSaveEdits: !!input.autoSaveEdits,
          },
        };
      case 'recordAdditionalRepositoryRootCandidates':
        return {
          ...base,
          label: 'Recording edit tracking repository roots',
          payload: {
            adapter: 'editTracking',
            action: 'recordAdditionalRepositoryRootCandidates',
            paths: input.paths ?? [],
          },
        };
      case 'recordEdit':
        if (!input.filePath || !input.editType) {
          throw new Error('[AilyChat][RuntimeOwnerEditTracking] recordEdit requires filePath and editType.');
        }
        return {
          ...base,
          label: 'Recording file edit',
          resource: {
            filePath: input.filePath,
            editType: input.editType,
          },
          payload: {
            adapter: 'editTracking',
            action: 'recordEdit',
            filePath: input.filePath,
            editType: input.editType,
          },
        };
      case 'publishCurrentSummary':
        return {
          ...base,
          label: 'Publishing edit summary',
          payload: {
            adapter: 'editTracking',
            action: 'publishCurrentSummary',
          },
        };
    }
  }

  private readSessionIdFromRequestMetadata(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return '';
    }
    const record = metadata as { sessionId?: unknown; requestRouting?: { sessionId?: unknown } };
    return this.normalizeString(record.sessionId) || this.normalizeString(record.requestRouting?.sessionId);
  }

  private requireSessionId(sessionId: string | null | undefined, operation: string): string {
    const normalizedSessionId = this.normalizeString(sessionId);
    if (!normalizedSessionId) {
      throw new Error(`[AilyChat][RuntimeOwnerEditTracking] ${operation} requires a host session id.`);
    }
    return normalizedSessionId;
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    const normalized = this.normalizeString(value);
    return normalized || undefined;
  }

  private normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeStringList(values: readonly unknown[] | undefined | null): string[] {
    if (!values) {
      return [];
    }
    return values
      .map(value => this.normalizeString(value))
      .filter(value => value.length > 0);
  }

  private normalizeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private normalizeNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}

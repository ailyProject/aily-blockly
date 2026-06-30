import { Injectable, inject } from '@angular/core';

import type { PendingFollowupRequest } from '../helpers/chat-pending-request';
import { ChatRuntimeViewMirrorProjectionService } from './chat-runtime-view-mirror-projection.service';
import { ChatSessionModelStoreService } from './chat-session-model-store.service';

@Injectable()
export class ChatPendingFollowupQueueService {
  private readonly modelStore = inject(ChatSessionModelStoreService);
  private readonly runtimeMirrorProjection = inject(ChatRuntimeViewMirrorProjectionService);

  read(sessionId: string | null | undefined): readonly PendingFollowupRequest[] {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId
      ? this.modelStore.get(targetSessionId)?.getPendingFollowupRequests() ?? []
      : [];
  }

  replace(
    sessionId: string | null | undefined,
    requests: readonly PendingFollowupRequest[] | null | undefined,
  ): readonly PendingFollowupRequest[] {
    const model = this.resolveModel(sessionId);
    return model ? model.replacePendingFollowupRequests(requests) : [];
  }

  enqueue(
    sessionId: string | null | undefined,
    request: PendingFollowupRequest,
  ): readonly PendingFollowupRequest[] {
    const model = this.resolveModel(sessionId);
    return model ? model.enqueuePendingFollowupRequest(request) : [];
  }

  remove(sessionId: string | null | undefined, requestId: string | null | undefined): boolean {
    const normalizedRequestId = this.normalizeSessionId(requestId);
    if (!normalizedRequestId) {
      return false;
    }

    return this.modelStore.get(sessionId)?.removePendingFollowupRequest(normalizedRequestId) ?? false;
  }

  clear(sessionId: string | null | undefined): void {
    this.modelStore.get(sessionId)?.clearPendingFollowupRequests();
  }

  sessionIds(): readonly string[] {
    return this.modelStore.values()
      .filter(model => model.getPendingFollowupRequests().length > 0)
      .map(model => model.sessionResource);
  }

  projectRuntimeState(
    sessionId: string | null | undefined,
    options: { readonly yieldRequested?: boolean | null | undefined } = {},
  ): boolean {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return false;
    }

    const pendingFollowupRequests = this.read(targetSessionId);
    this.runtimeMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch: {
        pendingFollowupRequests: pendingFollowupRequests.length > 0 ? pendingFollowupRequests : null,
        yieldRequested: options.yieldRequested === true,
      },
    });
    return true;
  }

  private resolveModel(sessionId: string | null | undefined) {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return null;
    }

    const reference = this.modelStore.acquireOrCreate({ sessionResource: targetSessionId });
    const model = reference.object;
    reference.dispose();
    return model;
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }
}

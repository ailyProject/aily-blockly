import { Injectable } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../tools/aily-chat/core/electron-chat-runtime-host-transport';
import {
  createSceneCodeReconciliationProvider,
  type SceneCodeReconciliationAgentRunInput,
} from '../tools/aily-chat/core/scene-code-reconciliation-provider';
import type {
  SceneCodeReconciliationCandidate,
  SceneCodeReconciliationInvocationInput,
} from '../tools/aily-chat/core/scene-code-reconciliation-invocation';

@Injectable({ providedIn: 'root' })
export class SceneCodeReconciliationProviderService {
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly provider = createSceneCodeReconciliationProvider(
    input => this.runScopedAgent(input),
  );

  async request(
    input: SceneCodeReconciliationInvocationInput,
    signal?: AbortSignal,
  ): Promise<SceneCodeReconciliationCandidate> {
    const requestId = portableRequestId(input?.request?.['requestId']);
    if (this.activeRequests.has(requestId)) {
      throw new Error(
        `Scene code reconciliation request is already active: ${requestId}`,
      );
    }
    const abortController = new AbortController();
    const forwardAbort = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(
          signal?.reason
            ?? new Error(
              'Scene code reconciliation request was cancelled by Host.',
            ),
        );
      }
    };
    if (signal?.aborted) {
      forwardAbort();
    } else {
      signal?.addEventListener('abort', forwardAbort, { once: true });
    }
    this.activeRequests.set(requestId, abortController);
    try {
      return await this.provider(input, {
        signal: abortController.signal,
      });
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.activeRequests.get(requestId) === abortController) {
        this.activeRequests.delete(requestId);
      }
    }
  }

  cancel(requestId: unknown): boolean {
    const normalized = portableRequestId(requestId);
    const active = this.activeRequests.get(normalized);
    if (!active) return false;
    if (!active.signal.aborted) {
      active.abort(
        new Error(
          'Scene code reconciliation request was cancelled by Host.',
        ),
      );
    }
    return true;
  }

  private async runScopedAgent(
    input: SceneCodeReconciliationAgentRunInput,
  ): Promise<unknown> {
    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('Independent Electron execution host is unavailable.');
    }
    const cancel = () => {
      void runtimeHost.cancelScopedAgent({
        invocationId: input.requestId,
      }).catch(() => undefined);
    };
    if (input.signal?.aborted) {
      cancel();
      throw abortReason(input.signal);
    }
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await runtimeHost.runScopedAgent({
        invocationId: input.requestId,
        agentType: input.agentType,
        prompt: input.prompt,
        runtimeMode: 'blockly',
      });
      if (
        result.invocationId !== input.requestId
        || result.agentType !== input.agentType
      ) {
        throw new Error(
          'Independent execution host returned a mismatched scoped Agent result.',
        );
      }
      return result;
    } finally {
      input.signal?.removeEventListener('abort', cancel);
    }
  }
}

function portableRequestId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new Error(
      'Scene code reconciliation requestId must be a portable identifier.',
    );
  }
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Scene code reconciliation request was cancelled.');
}

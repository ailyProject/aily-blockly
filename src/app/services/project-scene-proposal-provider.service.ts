import { Injectable } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../tools/aily-chat/core/electron-chat-runtime-host-transport';
import {
  createProjectSceneProposalProvider,
  type ProjectSceneAgentRunInput,
} from '../tools/aily-chat/core/project-scene-proposal-provider';
import type { ProjectSceneProposalInvocationInput } from '../tools/aily-chat/core/project-scene-proposal-invocation';

@Injectable({ providedIn: 'root' })
export class ProjectSceneProposalProviderService {
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly provider = createProjectSceneProposalProvider(
    input => this.runScopedAgent(input),
  );

  async request(
    input: ProjectSceneProposalInvocationInput,
  ): Promise<Record<string, unknown>> {
    const requestId = portableRequestId(input?.request?.['requestId']);
    if (this.activeRequests.has(requestId)) {
      throw new Error(`Project Scene proposal request is already active: ${requestId}`);
    }
    const abortController = new AbortController();
    this.activeRequests.set(requestId, abortController);
    try {
      return await this.provider(input, { signal: abortController.signal });
    } finally {
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
      active.abort(new Error('Project Scene proposal request was cancelled by Electron Main.'));
    }
    return true;
  }

  private async runScopedAgent(input: ProjectSceneAgentRunInput): Promise<unknown> {
    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('Independent Electron execution host is unavailable.');
    }
    const cancel = () => {
      void runtimeHost.cancelScopedAgent({ invocationId: input.requestId }).catch(() => undefined);
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
        throw new Error('Independent execution host returned a mismatched scoped Agent result.');
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
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error('Project Scene proposal requestId must be a portable identifier.');
  }
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Project Scene proposal request was cancelled.');
}

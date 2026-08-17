import { Injectable, NgZone } from '@angular/core';

import { createElectronChatRuntimeHostTransport } from '../tools/aily-chat/core/electron-chat-runtime-host-transport';
import {
  createProjectSceneProposalProvider,
  type ProjectSceneAgentRunInput,
} from '../tools/aily-chat/core/project-scene-proposal-provider';
import type { ProjectSceneProposalInvocationInput } from '../tools/aily-chat/core/project-scene-proposal-invocation';
import { UiService } from './ui.service';

@Injectable({ providedIn: 'root' })
export class ProjectSceneProposalProviderService {
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly provider = createProjectSceneProposalProvider(
    input => this.runVisibleChatAgent(input),
  );

  constructor(
    private readonly uiService: UiService,
    private readonly ngZone: NgZone,
  ) {}

  async request(
    input: ProjectSceneProposalInvocationInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const requestId = portableRequestId(input?.request?.['requestId']);
    if (this.activeRequests.has(requestId)) {
      throw new Error(`Project Scene proposal request is already active: ${requestId}`);
    }
    const abortController = new AbortController();
    const onAbort = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(signal?.reason ?? new Error(
          'Project Scene proposal request was cancelled by its Host caller.',
        ));
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    this.activeRequests.set(requestId, abortController);
    try {
      return await this.provider(input, { signal: abortController.signal });
    } finally {
      signal?.removeEventListener('abort', onAbort);
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

  private async runVisibleChatAgent(input: ProjectSceneAgentRunInput): Promise<unknown> {
    const runtimeHost = createElectronChatRuntimeHostTransport();
    const execution = this.ngZone.run(() => this.uiService.openAndRunStandardChatTurn(
      `@${input.agentType} ${input.prompt}`,
      `project-scene:${input.requestId}`,
      {
        autoSend: true,
        newChatFirst: true,
        cover: true,
      },
    ));
    const cancel = () => {
      execution.cancel(input.signal?.reason ?? new Error(
        'Project Scene proposal request was cancelled.',
      ));
      void execution.sessionId.then(
        sessionId => runtimeHost?.stopTurn(sessionId).catch(() => undefined),
        () => undefined,
      );
    };
    if (input.signal?.aborted) {
      cancel();
      throw abortReason(input.signal);
    }
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await execution.completion;
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

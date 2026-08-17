import { Injectable, NgZone } from '@angular/core';

import type {
  SimulatorMainAgentSceneChangeRequest,
} from '../integrations/simulator/simulator-main-agent-scene-change-port';
import {
  createSimulatorMainAgentSceneMessage,
} from '../integrations/simulator/simulator-main-agent-scene-message';
import { createElectronChatRuntimeHostTransport } from '../tools/aily-chat/core/electron-chat-runtime-host-transport';
import { UiService } from './ui.service';
import { ProjectService } from './project.service';
import { BlocklyService } from '../editors/blockly-editor/services/blockly.service';
import {
  assertAgentProjectMutationBaselineCurrent,
  createAgentProjectMutationBaseline,
} from '../tools/aily-chat/core/agent-project-mutation-guard';

export interface SimulatorMainAgentExecutionReceipt {
  readonly requestId: string;
  readonly agentRunId: string;
}

/**
 * Adapts one Simulator Scene change request to the existing visible main Chat.
 * It does not create a subagent, a hidden executor, a candidate ABS, or a
 * second project mutation protocol.
 */
@Injectable({ providedIn: 'root' })
export class SimulatorMainAgentSceneChangeProviderService {
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(
    private readonly uiService: UiService,
    private readonly ngZone: NgZone,
    private readonly projectService: ProjectService,
    private readonly blocklyService: BlocklyService,
  ) {}

  async request(
    input: SimulatorMainAgentSceneChangeRequest,
    signal?: AbortSignal,
  ): Promise<SimulatorMainAgentExecutionReceipt> {
    const requestId = portableRequestId(input?.requestId);
    if (this.activeRequests.has(requestId)) {
      throw new Error(
        `Simulator main-Agent request is already active: ${requestId}`,
      );
    }
    const abortController = new AbortController();
    const forwardAbort = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(
          signal?.reason
            ?? new Error('Simulator main-Agent request was cancelled by Host.'),
        );
      }
    };
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.activeRequests.set(requestId, abortController);
    try {
      return await this.runVisibleMainAgent(input, abortController.signal);
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
      active.abort(new Error('Simulator main-Agent request was cancelled.'));
    }
    return true;
  }

  private async runVisibleMainAgent(
    input: SimulatorMainAgentSceneChangeRequest,
    signal: AbortSignal,
  ): Promise<SimulatorMainAgentExecutionReceipt> {
    const projectMutationBaseline = createAgentProjectMutationBaseline(
      this.projectService.currentProjectPath,
      this.blocklyService.getWorkspaceUserEditRevision(),
    );
    const runtimeHost = createElectronChatRuntimeHostTransport();
    const execution = this.ngZone.run(() => (
      this.uiService.openAndRunStandardChatTurn(
        createSimulatorMainAgentSceneMessage(input),
        `simulator-main-agent:${input.requestId}`,
        {
          autoSend: true,
          newChatFirst: true,
          cover: true,
        },
      )
    ));
    const cancel = () => {
      execution.cancel(
        signal.reason ?? new Error('Simulator main-Agent request was cancelled.'),
      );
      void execution.sessionId.then(
        sessionId => runtimeHost?.stopTurn(sessionId).catch(() => undefined),
        () => undefined,
      );
    };
    if (signal.aborted) {
      cancel();
      throw abortReason(signal);
    }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await execution.completion;
      const currentProjectPath = this.projectService.currentProjectPath;
      const currentWorkspaceUserEditRevision =
        this.blocklyService.getWorkspaceUserEditRevision();
      try {
        assertAgentProjectMutationBaselineCurrent(
          projectMutationBaseline,
          currentProjectPath,
          currentWorkspaceUserEditRevision,
        );
      } catch (error) {
        const diagnostic = {
          requestId: input.requestId,
          errorCode: readErrorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
          baselineProjectPath: projectMutationBaseline.projectPath,
          currentProjectPath,
          baselineWorkspaceUserEditRevision:
            projectMutationBaseline.workspaceUserEditRevision,
          currentWorkspaceUserEditRevision,
        };
        console.error(
          `[SimulatorMainAgent] completion rejected ${JSON.stringify(diagnostic)}`,
        );
        throw error;
      }
      return Object.freeze({
        requestId: input.requestId,
        agentRunId: portableAgentRunId(result.sessionId),
      });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function portableRequestId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new Error('Simulator main-Agent requestId must be portable.');
  }
  return value;
}

function portableAgentRunId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new Error('Simulator main-Agent turn did not return a sessionId.');
  }
  const normalized = value.trim().replace(/[^A-Za-z0-9._:-]/gu, '-');
  return normalized.length <= 128
    ? normalized
    : normalized.slice(0, 128);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Simulator main-Agent request was cancelled.');
}

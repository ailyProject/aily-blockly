import { Injectable } from '@angular/core';
import { AilyChatDemandSessionService } from '@integration/simulator/public-api';

import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';
import {
  createSimulatorMainAgentSceneMessage,
} from './simulator-main-agent-scene-message';

export interface SimulatorMainAgentExecutionReceipt {
  readonly requestId: string;
  readonly agentRunId: string;
}

/**
 * Sends a Scene-to-code request to the visible main Agent session owned by the
 * Aily Chat subapp. Simulator remains an independent provider client and no
 * Angular Chat runtime, hidden executor, or workspace CAS protocol is used.
 */
@Injectable({ providedIn: 'root' })
export class SimulatorMainAgentSceneChangeProviderService {
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(
    private readonly demandSessions: AilyChatDemandSessionService,
  ) {}

  async request(
    input: SimulatorMainAgentSceneChangeRequest,
    signal?: AbortSignal,
  ): Promise<SimulatorMainAgentExecutionReceipt> {
    const requestId = portableRequestId(input?.requestId);
    if (this.activeRequests.has(requestId)) {
      throw new Error(`Simulator main-Agent request is already active: ${requestId}`);
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(
      signal?.reason ?? new Error('Simulator main-Agent request was cancelled by Host.'),
    );
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.activeRequests.set(requestId, controller);

    try {
      const result = await this.demandSessions.requestCodeSync(
        createSimulatorMainAgentSceneMessage(input),
        '同步 Simulator 连线场景到项目代码',
        controller.signal,
      );
      return Object.freeze({
        requestId,
        agentRunId: portableAgentRunId(result.sessionId),
      });
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.activeRequests.get(requestId) === controller) {
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
  return normalized.length <= 128 ? normalized : normalized.slice(0, 128);
}

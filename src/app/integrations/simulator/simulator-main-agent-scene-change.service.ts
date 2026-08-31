import { Injectable } from '@angular/core';

import { SimulatorMainAgentSceneChangeProviderService } from './simulator-main-agent-scene-change-provider.service';
import type {
  SimulatorMainAgentSceneChangePort,
  SimulatorMainAgentSceneChangeRequest,
  SimulatorMainAgentSceneChangeResult,
} from './simulator-main-agent-scene-change-port';

/**
 * Project-side port used by Build execution. The ordinary visible main Agent
 * owns project/board/library changes; this adapter only returns its scoped
 * completion receipt.
 */
@Injectable({ providedIn: 'root' })
export class SimulatorMainAgentSceneChangeService
implements SimulatorMainAgentSceneChangePort {
  constructor(
    private readonly mainAgent: SimulatorMainAgentSceneChangeProviderService,
  ) {}

  async execute(
    request: SimulatorMainAgentSceneChangeRequest,
    signal: AbortSignal,
  ): Promise<SimulatorMainAgentSceneChangeResult> {
    const receipt = await this.mainAgent.request(request, signal);
    if (receipt.requestId !== request.requestId) {
      throw new Error('Simulator main-Agent receipt scope does not match.');
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: 'aily-simulator-main-agent-scene-change-result',
      requestId: request.requestId,
      projectIdentity: request.projectIdentity,
      sceneId: request.sceneId,
      graphSemanticRevision: request.graphSemanticRevision,
      outcome: 'completed',
      agentRunId: receipt.agentRunId,
    });
  }
}

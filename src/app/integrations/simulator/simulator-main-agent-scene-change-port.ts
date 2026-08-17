import type {
  SceneArtifactRebuildRequest,
} from '@aily-project/simulator-host-sdk';

/**
 * Revision-locked request passed from Build orchestration to the ordinary
 * Blockly main Agent. This is a Host-internal port, not a Simulator runtime
 * control protocol.
 */
export interface SimulatorMainAgentSceneChangeRequest {
  readonly schemaVersion: 1;
  readonly kind: 'aily-simulator-main-agent-scene-change-request';
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly graphSemanticRevision: string;
  readonly sceneDocument: SceneArtifactRebuildRequest['sceneDocument'];
}

/** Receipt that the existing visible main-Agent turn completed. */
export interface SimulatorMainAgentSceneChangeResult {
  readonly schemaVersion: 1;
  readonly kind: 'aily-simulator-main-agent-scene-change-result';
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly graphSemanticRevision: string;
  readonly outcome: 'completed';
  readonly agentRunId: string;
}

export interface SimulatorMainAgentSceneChangePort {
  execute(
    request: SimulatorMainAgentSceneChangeRequest,
    signal: AbortSignal,
  ): Promise<SimulatorMainAgentSceneChangeResult>;
}

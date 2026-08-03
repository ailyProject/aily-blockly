import {
  SimulatorSceneCodeReconciliationCoordinator,
  type SimulatorSceneCodeReconciliationPort,
  type SimulatorSceneCodeReconciliationRequest,
} from './simulator-scene-code-reconciliation-coordinator';
import type {
  SceneCodeReconciliationCandidate,
  SceneCodeReconciliationInvocationInput,
} from '../../tools/aily-chat/core/scene-code-reconciliation-invocation';

export interface SimulatorSceneCodeCandidateProviderPort {
  request(
    input: SceneCodeReconciliationInvocationInput,
    signal: AbortSignal,
  ): Promise<SceneCodeReconciliationCandidate>;
}

export interface SimulatorSceneCodeApprovalDecision {
  readonly approved: boolean;
  readonly approvalId: string;
}

export interface SimulatorSceneCodeApprovalPort {
  requestApproval(
    request: SimulatorSceneCodeReconciliationRequest,
    candidate: SceneCodeReconciliationCandidate,
    signal: AbortSignal,
  ): Promise<SimulatorSceneCodeApprovalDecision>;
}

export interface SimulatorBlocklyProgramMutationPort {
  readCurrentAbs(): string;
  applyAbs(
    content: string,
    request: SimulatorSceneCodeReconciliationRequest,
    approvalId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SimulatorSceneCodeReconciliationProductPortOptions {
  readonly candidates: SimulatorSceneCodeCandidateProviderPort;
  readonly approvals: SimulatorSceneCodeApprovalPort;
  readonly program: SimulatorBlocklyProgramMutationPort;
  readonly maxPendingRequests?: number;
}

/**
 * Creates the real Host product workflow used by Build execution.
 *
 * The scoped Agent can only return a candidate. The Host then checks that the
 * Blockly working copy is unchanged, obtains an explicit user decision, and
 * applies the complete ABS candidate through the product-owned mutation port.
 * No Simulator process or iframe authority crosses this boundary.
 */
export function createSimulatorSceneCodeReconciliationProductPort(
  options: SimulatorSceneCodeReconciliationProductPortOptions,
): SimulatorSceneCodeReconciliationPort {
  validateOptions(options);
  let coordinator!: SimulatorSceneCodeReconciliationCoordinator;
  coordinator = new SimulatorSceneCodeReconciliationCoordinator({
    ...(options.maxPendingRequests === undefined
      ? {}
      : { maxPendingRequests: options.maxPendingRequests }),
    present: async (request, signal) => {
      const currentAbs = requireAbs(options.program.readCurrentAbs());
      const candidate = await options.candidates.request({
        request: structuredClone(
          request as unknown as Record<string, unknown>,
        ),
        currentAbs,
      }, signal);
      throwIfAborted(signal);
      requireCandidateScope(candidate, request);
      requireUnchangedProgram(
        options.program.readCurrentAbs(),
        currentAbs,
      );

      const approval = await options.approvals.requestApproval(
        structuredClone(request),
        structuredClone(candidate),
        signal,
      );
      throwIfAborted(signal);
      const approvalId = requirePortableIdentifier(
        approval.approvalId,
        'approvalId',
      );
      if (!approval.approved) {
        coordinator.complete({
          schemaVersion: 1,
          kind: 'aily-simulator-scene-code-reconciliation-result',
          requestId: request.requestId,
          projectIdentity: request.projectIdentity,
          sceneId: request.sceneId,
          graphSemanticRevision: request.graphSemanticRevision,
          decision: 'rejected',
          outcome: 'rejected',
          approvalId,
          agentRunId: candidate.agentRunId,
        });
        return;
      }

      requireUnchangedProgram(
        options.program.readCurrentAbs(),
        currentAbs,
      );
      if (candidate.outcome === 'applied') {
        const candidateAbs = requireAbs(candidate.candidateAbs);
        await options.program.applyAbs(
          candidateAbs,
          structuredClone(request),
          approvalId,
          signal,
        );
        throwIfAborted(signal);
        if (
          normalizeAbs(options.program.readCurrentAbs())
          !== normalizeAbs(candidateAbs)
        ) {
          throw new Error(
            'Blockly ABS import did not produce the approved candidate.',
          );
        }
      }

      coordinator.complete({
        schemaVersion: 1,
        kind: 'aily-simulator-scene-code-reconciliation-result',
        requestId: request.requestId,
        projectIdentity: request.projectIdentity,
        sceneId: request.sceneId,
        graphSemanticRevision: request.graphSemanticRevision,
        decision: 'approved',
        outcome: candidate.outcome,
        approvalId,
        agentRunId: candidate.agentRunId,
      });
    },
  });
  return coordinator;
}

function validateOptions(
  options: SimulatorSceneCodeReconciliationProductPortOptions,
): void {
  if (
    !options?.candidates
    || typeof options.candidates.request !== 'function'
    || !options.approvals
    || typeof options.approvals.requestApproval !== 'function'
    || !options.program
    || typeof options.program.readCurrentAbs !== 'function'
    || typeof options.program.applyAbs !== 'function'
  ) {
    throw new TypeError(
      'Scene code reconciliation product ports are invalid.',
    );
  }
}

function requireCandidateScope(
  candidate: SceneCodeReconciliationCandidate,
  request: SimulatorSceneCodeReconciliationRequest,
): void {
  if (
    candidate.schemaVersion !== 1
    || candidate.kind !== 'aily-scene-code-reconciliation-agent-candidate'
    || candidate.requestId !== request.requestId
    || (
      candidate.outcome !== 'applied'
      && candidate.outcome !== 'already-aligned'
    )
    || !candidate.agentRunId
  ) {
    throw new Error(
      'Scene code reconciliation Agent returned a mismatched candidate.',
    );
  }
  if (
    (candidate.outcome === 'applied' && candidate.candidateAbs === null)
    || (
      candidate.outcome === 'already-aligned'
      && candidate.candidateAbs !== null
    )
  ) {
    throw new Error(
      'Scene code reconciliation candidate is inconsistent.',
    );
  }
}

function requireUnchangedProgram(actual: string, expected: string): void {
  if (normalizeAbs(requireAbs(actual)) !== normalizeAbs(expected)) {
    throw new Error(
      'Blockly working copy changed during Scene code reconciliation.',
    );
  }
}

function requireAbs(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new Error('Current Blockly ABS program is unavailable.');
  }
  return value;
}

function normalizeAbs(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trimEnd();
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new Error(`${label} must be a portable identifier.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Scene code reconciliation was cancelled.');
}

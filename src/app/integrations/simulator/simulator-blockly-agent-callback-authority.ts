import {
  validateProjectHardwareIntentSnapshotV1,
  type ProjectHardwareIntentSnapshotV1,
  type ProjectSceneGenerationRequestV1,
  type SimulatorAgentHostProviderAdapterOptions,
  type SimulatorAgentSceneApprovalDecision,
  type SimulatorSubappHostAgentSceneProposalDecisionV1,
} from '@aily-project/simulator-host-sdk';

import type {
  SimulatorActiveProjectBindingPort,
} from './simulator-build-execution-port';

type AgentSceneProposal = NonNullable<
  SimulatorSubappHostAgentSceneProposalDecisionV1['proposal']
>;

export interface SimulatorProjectHardwareIntentPort {
  resolve(
    request: Readonly<{
      requestId: string;
      projectIdentity: string;
    }>,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
}

export interface SimulatorProjectSceneProposalPort {
  request(
    input: Readonly<{
      request: ProjectSceneGenerationRequestV1;
      hardwareIntent: ProjectHardwareIntentSnapshotV1;
    }>,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
}

export interface SimulatorAgentSceneApprovalPort {
  requestApproval(
    request: ProjectSceneGenerationRequestV1,
    proposal: AgentSceneProposal,
    signal: AbortSignal,
  ): Readonly<{
    approved: boolean;
    approvalId: string;
  }> | Promise<Readonly<{
    approved: boolean;
    approvalId: string;
  }>>;
}

export interface SimulatorBlocklyAgentCallbackAuthorityOptions {
  projectRoot: string;
  projectIdentity: string;
  sceneId?: string;
  activeProject: SimulatorActiveProjectBindingPort;
  hardwareIntent: SimulatorProjectHardwareIntentPort;
  proposals: SimulatorProjectSceneProposalPort;
  approvals: SimulatorAgentSceneApprovalPort;
  now?: () => number;
}

/**
 * Project-scoped Blockly implementation of the Host SDK Agent callbacks.
 * The Agent can produce only a bounded native Scene proposal. The callback
 * rechecks active Project scope before and after every async boundary and the
 * user-owned approval port is the only path to an approved decision.
 */
export class SimulatorBlocklyAgentCallbackAuthority {
  readonly callbacks: SimulatorAgentHostProviderAdapterOptions;

  private readonly projectRoot: string;
  private readonly projectIdentity: string;
  private readonly sceneId: string;
  private readonly activeProject: SimulatorActiveProjectBindingPort;
  private readonly hardwareIntent: SimulatorProjectHardwareIntentPort;
  private readonly proposals: SimulatorProjectSceneProposalPort;
  private readonly approvals: SimulatorAgentSceneApprovalPort;
  private readonly now: () => number;
  private readonly pendingControllers = new Set<AbortController>();
  private closed = false;

  constructor(options: SimulatorBlocklyAgentCallbackAuthorityOptions) {
    this.projectRoot = requireNonEmpty(options.projectRoot, 'projectRoot');
    this.projectIdentity = requirePortableIdentifier(
      options.projectIdentity,
      'projectIdentity',
    );
    this.sceneId = requirePortableIdentifier(options.sceneId ?? 'main', 'sceneId');
    if (
      !options.activeProject
      || typeof options.activeProject.readActiveBinding !== 'function'
      || typeof options.activeProject.isSameProjectRoot !== 'function'
    ) {
      throw new TypeError('Agent active Project binding port is invalid.');
    }
    if (!options.hardwareIntent || typeof options.hardwareIntent.resolve !== 'function') {
      throw new TypeError('Agent hardware intent port is invalid.');
    }
    if (!options.proposals || typeof options.proposals.request !== 'function') {
      throw new TypeError('Agent Scene proposal port is invalid.');
    }
    if (!options.approvals || typeof options.approvals.requestApproval !== 'function') {
      throw new TypeError('Agent Scene approval port is invalid.');
    }
    this.activeProject = options.activeProject;
    this.hardwareIntent = options.hardwareIntent;
    this.proposals = options.proposals;
    this.approvals = options.approvals;
    this.now = options.now ?? Date.now;
    this.callbacks = Object.freeze({
      proposeScene: (request, signal) => this.runScoped(
        signal,
        scopedSignal => this.proposeScene(request, scopedSignal),
      ),
      approveSceneProposal: (input, signal) => this.runScoped(
        signal,
        scopedSignal => this.approveSceneProposal(
          input.request,
          input.proposal,
          scopedSignal,
        ),
      ),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending(new Error('Agent callback authority is closed.'));
  }

  cancelPending(
    reason: Error = new Error('Bound Blockly Project changed.'),
  ): void {
    for (const controller of this.pendingControllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  private async proposeScene(
    request: ProjectSceneGenerationRequestV1,
    signal: AbortSignal,
  ): Promise<AgentSceneProposal> {
    this.requireActiveRequest(request, signal);
    const hardwareIntent = validateProjectHardwareIntentSnapshotV1(
      await this.hardwareIntent.resolve(Object.freeze({
        requestId: request.requestId,
        projectIdentity: request.projectIdentity,
      }), signal),
    );
    this.requireActiveRequest(request, signal);
    if (
      hardwareIntent.requestId !== request.requestId
      || hardwareIntent.projectIdentity !== request.projectIdentity
    ) {
      throw new Error('Project hardware intent is outside the Agent request scope.');
    }
    const proposal = await this.proposals.request(Object.freeze({
      request: structuredClone(request),
      hardwareIntent: structuredClone(hardwareIntent),
    }), signal);
    this.requireActiveRequest(request, signal);
    return requireScopedProposal(proposal, request);
  }

  private async approveSceneProposal(
    request: ProjectSceneGenerationRequestV1,
    proposal: AgentSceneProposal,
    signal: AbortSignal,
  ): Promise<SimulatorAgentSceneApprovalDecision> {
    this.requireActiveRequest(request, signal);
    const scopedProposal = requireScopedProposal(proposal, request);
    const decision = await this.approvals.requestApproval(
      structuredClone(request),
      structuredClone(scopedProposal),
      signal,
    );
    this.requireActiveRequest(request, signal);
    const approvalId = requirePortableIdentifier(
      decision?.approvalId,
      'approvalId',
    );
    return Object.freeze({
      disposition: decision.approved ? 'approved' : 'rejected',
      approvalId,
    });
  }

  private requireActiveRequest(
    request: ProjectSceneGenerationRequestV1,
    signal: AbortSignal,
  ): void {
    throwIfAborted(signal);
    if (this.closed) throw new Error('Agent callback authority is closed.');
    if (
      request.projectIdentity !== this.projectIdentity
      || request.sceneId !== this.sceneId
    ) {
      throw new Error('Agent request is outside the bound Project Scene.');
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('Agent callback authority clock is invalid.');
    }
    if (now >= request.expiresAtUnixMs) {
      throw new Error('Agent request has expired.');
    }
    const binding = this.activeProject.readActiveBinding();
    if (
      !binding
      || binding.editorKind !== 'blockly'
      || binding.projectIdentity !== this.projectIdentity
      || binding.sceneId !== this.sceneId
      || !this.activeProject.isSameProjectRoot(
        binding.projectRoot,
        this.projectRoot,
      )
    ) {
      throw new Error('Bound Blockly Project is no longer active.');
    }
  }

  private async runScoped<T>(
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(externalSignal.reason ?? new Error(
          'Agent callback was cancelled by its Host caller.',
        ));
      }
    };
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
    this.pendingControllers.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.pendingControllers.delete(controller);
      externalSignal.removeEventListener('abort', abort);
    }
  }
}

function requireScopedProposal(
  value: unknown,
  request: ProjectSceneGenerationRequestV1,
): AgentSceneProposal {
  const proposal = record(value, 'Agent Scene proposal');
  const target = record(proposal['target'], 'Agent Scene proposal target');
  const base = record(proposal['base'], 'Agent Scene proposal base');
  const expectedReason = request.reason === 'legacy-detected'
    ? 'legacy-regeneration'
    : 'user-requested-change';
  if (
    proposal['schemaVersion'] !== 1
    || proposal['kind'] !== 'aily-agent-scene-change-proposal'
    || proposal['reason'] !== expectedReason
    || target['projectIdentity'] !== request.projectIdentity
    || target['sceneId'] !== request.sceneId
    || base['visualRevision'] !== request.base.visualRevision
    || base['graphSemanticRevision'] !== request.base.graphSemanticRevision
    || base['catalogRevision'] !== request.base.catalogRevision
  ) {
    throw new Error('Agent Scene proposal is outside the requested revision scope.');
  }
  return structuredClone(proposal) as unknown as AgentSceneProposal;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Agent callback was cancelled.');
}

function requirePortableIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

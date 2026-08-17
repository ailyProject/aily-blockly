import {
  validateProjectHardwareIntentSnapshotV1,
  validateProjectWiringIntentV1,
  type ProjectHardwareIntentSnapshotV1,
  type ProjectSceneGenerationRequestV1,
  type ProjectWiringIntentV1,
  type SimulatorAgentHostProviderAdapterOptions,
  type SimulatorSubappHostAgentSceneCandidateV1,
} from '@aily-project/simulator-host-sdk';

import type {
  SimulatorActiveProjectBindingPort,
} from './simulator-build-execution-port';

type AgentSceneWiringIntent = NonNullable<
  SimulatorSubappHostAgentSceneCandidateV1['intent']
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

export interface SimulatorProjectWiringIntentPort {
  request(
    input: Readonly<{
      request: ProjectSceneGenerationRequestV1;
      hardwareIntent: ProjectHardwareIntentSnapshotV1;
    }>,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
}

export interface SimulatorBlocklyAgentCallbackAuthorityOptions {
  projectRoot: string;
  projectIdentity: string;
  sceneId?: string;
  activeProject: SimulatorActiveProjectBindingPort;
  hardwareIntent: SimulatorProjectHardwareIntentPort;
  wiringIntents: SimulatorProjectWiringIntentPort;
  now?: () => number;
}

/**
 * Project-scoped Blockly implementation of the Host SDK Agent callbacks.
 * The Agent can produce only a bounded semantic wiring intent. The callback
 * rechecks active Project scope before and after every async boundary. It has
 * no approval callback: Simulator owns candidate preview, decision and CAS.
 */
export class SimulatorBlocklyAgentCallbackAuthority {
  readonly callbacks: SimulatorAgentHostProviderAdapterOptions;

  private readonly projectRoot: string;
  private readonly projectIdentity: string;
  private readonly sceneId: string;
  private readonly activeProject: SimulatorActiveProjectBindingPort;
  private readonly hardwareIntent: SimulatorProjectHardwareIntentPort;
  private readonly wiringIntents: SimulatorProjectWiringIntentPort;
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
    if (!options.wiringIntents || typeof options.wiringIntents.request !== 'function') {
      throw new TypeError('Agent wiring-intent port is invalid.');
    }
    this.activeProject = options.activeProject;
    this.hardwareIntent = options.hardwareIntent;
    this.wiringIntents = options.wiringIntents;
    this.now = options.now ?? Date.now;
    this.callbacks = Object.freeze({
      createWiringIntent: (request, signal) => this.runScoped(
        signal,
        scopedSignal => this.createWiringIntent(request, scopedSignal),
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

  private async createWiringIntent(
    request: ProjectSceneGenerationRequestV1,
    signal: AbortSignal,
  ): Promise<AgentSceneWiringIntent> {
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
    const intent = await this.wiringIntents.request(Object.freeze({
      request: structuredClone(request),
      hardwareIntent: structuredClone(hardwareIntent),
    }), signal);
    this.requireActiveRequest(request, signal);
    return requireScopedIntent(intent, request);
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

function requireScopedIntent(
  value: unknown,
  request: ProjectSceneGenerationRequestV1,
): AgentSceneWiringIntent {
  const intent: ProjectWiringIntentV1 = validateProjectWiringIntentV1(value);
  if (intent.requestId !== request.requestId) {
    throw new Error('Agent wiring intent is outside the requested generation scope.');
  }
  return structuredClone(intent);
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

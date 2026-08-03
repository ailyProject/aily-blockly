import type {
  SceneArtifactRebuildRequest,
  SimulatorSubappHostArtifactDescriptorV1,
} from '@aily-project/simulator-host-sdk';

import type {
  SimulatorBuildExecutionObserver,
  SimulatorBuildExecutionPort,
} from './simulator-build-callback-authority';
import type {
  SimulatorSceneCodeReconciliationPort,
  SimulatorSceneCodeReconciliationRequest,
} from './simulator-scene-code-reconciliation-coordinator';

const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface SimulatorActiveProjectBinding {
  readonly projectRoot: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly editorKind: 'blockly' | 'coder';
}

export interface SimulatorActiveProjectBindingPort {
  readActiveBinding(): SimulatorActiveProjectBinding | null;
  isSameProjectRoot(left: string, right: string): boolean;
}

export interface SimulatorBlocklyBuildRequest {
  readonly requestId: string;
  readonly projectRoot: string;
  readonly projectIdentity: string;
  readonly graphSemanticRevision: string;
}

export interface SimulatorBlocklyBuilderPort {
  build(
    request: SimulatorBlocklyBuildRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface SimulatorLatestArtifactDescriptorPort {
  readLatest(
    projectIdentity: string,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostArtifactDescriptorV1>;
}

export interface BlocklySimulatorBuildExecutionPortOptions {
  projectRoot: string;
  projectIdentity: string;
  sceneId?: string;
  activeProject: SimulatorActiveProjectBindingPort;
  reconciliation: SimulatorSceneCodeReconciliationPort;
  builder: SimulatorBlocklyBuilderPort;
  artifacts: SimulatorLatestArtifactDescriptorPort;
}

type SimulatorBuildErrorCode =
  | 'request-rejected'
  | 'project-unavailable'
  | 'generation-failed'
  | 'compile-failed'
  | 'artifact-staging-failed'
  | 'cancelled';

/**
 * Product-owned Scene -> Agent -> Builder -> Artifact orchestration.
 *
 * The port is bound to one active Blockly Project and returns only a Host SDK
 * Artifact descriptor. It never imports or controls Simulator Runtime state.
 */
export class BlocklySimulatorBuildExecutionPort
implements SimulatorBuildExecutionPort {
  private readonly projectRoot: string;
  private readonly projectIdentity: string;
  private readonly sceneId: string;
  private readonly activeProject: SimulatorActiveProjectBindingPort;
  private readonly reconciliation: SimulatorSceneCodeReconciliationPort;
  private readonly builder: SimulatorBlocklyBuilderPort;
  private readonly artifacts: SimulatorLatestArtifactDescriptorPort;

  constructor(options: BlocklySimulatorBuildExecutionPortOptions) {
    this.projectRoot = requireNonEmpty(options.projectRoot, 'projectRoot');
    this.projectIdentity = requirePortableIdentifier(
      options.projectIdentity,
      'projectIdentity',
    );
    this.sceneId = requirePortableIdentifier(
      options.sceneId ?? 'main',
      'sceneId',
    );
    if (
      !options.activeProject
      || typeof options.activeProject.readActiveBinding !== 'function'
      || typeof options.activeProject.isSameProjectRoot !== 'function'
    ) {
      throw new TypeError('Active Project binding port is invalid.');
    }
    if (
      !options.reconciliation
      || typeof options.reconciliation.reconcile !== 'function'
    ) {
      throw new TypeError('Scene code reconciliation port is invalid.');
    }
    if (!options.builder || typeof options.builder.build !== 'function') {
      throw new TypeError('Blockly Builder port is invalid.');
    }
    if (
      !options.artifacts
      || typeof options.artifacts.readLatest !== 'function'
    ) {
      throw new TypeError('Latest Artifact descriptor port is invalid.');
    }
    this.activeProject = options.activeProject;
    this.reconciliation = options.reconciliation;
    this.builder = options.builder;
    this.artifacts = options.artifacts;
  }

  async reconcileAndBuild(
    request: SceneArtifactRebuildRequest,
    observer: SimulatorBuildExecutionObserver,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostArtifactDescriptorV1> {
    throwIfAborted(signal);
    this.requireRequestScope(request);
    observer.report('resolving', 100);
    this.requireActiveBlocklyProject();

    const reconciliationRequest: SimulatorSceneCodeReconciliationRequest = {
      schemaVersion: 1,
      kind: 'aily-simulator-scene-code-reconciliation-request',
      requestId: request.requestId,
      projectIdentity: request.projectIdentity,
      sceneId: request.sceneId,
      graphSemanticRevision: request.sceneRevision,
      sceneDocument: structuredClone(request.sceneDocument),
    };
    observer.report('generating', 250);
    let reconciliation;
    try {
      reconciliation = await this.reconciliation.reconcile(
        reconciliationRequest,
        signal,
      );
    } catch (error) {
      throw mappedError(error, signal, 'generation-failed');
    }
    throwIfAborted(signal);
    this.requireActiveBlocklyProject();
    if (reconciliation.decision !== 'approved') {
      throw buildError(
        'request-rejected',
        'Scene code reconciliation was rejected.',
      );
    }
    if (
      reconciliation.requestId !== request.requestId
      || reconciliation.projectIdentity !== request.projectIdentity
      || reconciliation.sceneId !== request.sceneId
      || reconciliation.graphSemanticRevision !== request.sceneRevision
      || (
        reconciliation.outcome !== 'applied'
        && reconciliation.outcome !== 'already-aligned'
      )
    ) {
      throw buildError(
        'generation-failed',
        'Scene code reconciliation returned a mismatched completion.',
      );
    }

    observer.report('compiling', 500);
    try {
      await this.builder.build({
        requestId: request.requestId,
        projectRoot: this.projectRoot,
        projectIdentity: this.projectIdentity,
        graphSemanticRevision: request.sceneRevision,
      }, signal);
    } catch (error) {
      throw mappedError(error, signal, 'compile-failed');
    }
    throwIfAborted(signal);
    this.requireActiveBlocklyProject();

    observer.report('staging', 900);
    try {
      return await this.artifacts.readLatest(
        this.projectIdentity,
        signal,
      );
    } catch (error) {
      throw mappedError(error, signal, 'artifact-staging-failed');
    }
  }

  private requireRequestScope(request: SceneArtifactRebuildRequest): void {
    if (
      request.projectIdentity !== this.projectIdentity
      || request.sceneId !== this.sceneId
      || request.sceneDocument.sceneId !== this.sceneId
      || request.sceneRevision
        !== request.sceneDocument.graphSemanticRevision
    ) {
      throw buildError(
        'project-unavailable',
        'Build request does not match the bound Project Scene.',
      );
    }
  }

  private requireActiveBlocklyProject(): SimulatorActiveProjectBinding {
    const active = this.activeProject.readActiveBinding();
    if (
      !active
      || active.editorKind !== 'blockly'
      || active.projectIdentity !== this.projectIdentity
      || active.sceneId !== this.sceneId
      || !this.activeProject.isSameProjectRoot(
        active.projectRoot,
        this.projectRoot,
      )
    ) {
      throw buildError(
        'project-unavailable',
        'The bound Blockly Project is no longer active.',
      );
    }
    return active;
  }
}

function mappedError(
  error: unknown,
  signal: AbortSignal,
  fallback: SimulatorBuildErrorCode,
): Error {
  if (signal.aborted) {
    return buildError('cancelled', abortReason(signal).message);
  }
  if (
    error
    && typeof error === 'object'
    && 'simulatorBuildErrorCode' in error
  ) {
    return error as Error;
  }
  return buildError(
    fallback,
    error instanceof Error ? error.message : String(error),
  );
}

function buildError(
  simulatorBuildErrorCode: SimulatorBuildErrorCode,
  message: string,
): Error {
  return Object.assign(new Error(message), { simulatorBuildErrorCode });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw buildError('cancelled', abortReason(signal).message);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Simulator Build request was cancelled.');
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !PORTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

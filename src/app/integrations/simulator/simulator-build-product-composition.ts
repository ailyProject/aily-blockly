import type {
  SimulatorBuildHostProviderAdapterOptions,
  SimulatorProjectHostProviderAdapterOptions,
  SimulatorSubappHostArtifactDescriptorV1,
} from '@aily-project/simulator-host-sdk';

import {
  SimulatorBuildCallbackAuthority,
  type SimulatorBuildCallbackAuthorityOptions,
} from './simulator-build-callback-authority';
import {
  BlocklySimulatorBuildExecutionPort,
  type SimulatorActiveProjectBindingPort,
} from './simulator-build-execution-port';
import {
  createSimulatorBlocklyBuilderPort,
  type SimulatorBlocklyBuilderServicePort,
} from './simulator-blockly-builder-port';
import {
  SimulatorProjectArtifactCallbackAuthority,
  type SimulatorProjectArtifactCallbackAuthorityOptions,
} from './simulator-project-artifact-callback-authority';
import type {
  SimulatorSceneCodeReconciliationPort,
} from './simulator-scene-code-reconciliation-coordinator';

export interface SimulatorBuildProductCompositionOptions {
  projectRoot: string;
  projectIdentity: string;
  workspaceIdentity: string;
  sceneId?: string;
  files: SimulatorProjectArtifactCallbackAuthorityOptions['files'];
  activeProject: SimulatorActiveProjectBindingPort;
  reconciliation: SimulatorSceneCodeReconciliationPort;
  builderService: SimulatorBlocklyBuilderServicePort;
  maxBuildJobs?: SimulatorBuildCallbackAuthorityOptions['maxJobs'];
  artifactReferenceTtlMs?: number;
  maxArtifactReferences?: number;
  now?: () => number;
  createArtifactReference?: () => string;
  createSceneCommitId?: () => string;
}

export interface SimulatorBuildProductCompositionSnapshot {
  readonly closed: boolean;
  readonly project: ReturnType<
    SimulatorProjectArtifactCallbackAuthority['snapshot']
  >;
  readonly build: ReturnType<SimulatorBuildCallbackAuthority['snapshot']>;
}

/**
 * Project-scoped Blockly product composition behind the versioned Host SDK.
 *
 * It joins only Host product authorities: Project/Artifact persistence,
 * Scene-to-code reconciliation, the request-scoped Builder, and Build job
 * progress. It never starts or controls a Simulator process, QEMU, GDB,
 * Runtime Scene, or iframe.
 */
export class SimulatorBuildProductComposition {
  readonly projectCallbacks: Pick<
    SimulatorProjectHostProviderAdapterOptions,
    | 'readContext'
    | 'readScene'
    | 'writeScene'
    | 'readArtifact'
    | 'readArtifactChunk'
  >;
  readonly buildCallbacks: Pick<
    SimulatorBuildHostProviderAdapterOptions,
    'requestArtifact' | 'subscribeProgress'
  >;

  private readonly projectAuthority: SimulatorProjectArtifactCallbackAuthority;
  private readonly buildAuthority: SimulatorBuildCallbackAuthority;
  private closed = false;

  constructor(options: SimulatorBuildProductCompositionOptions) {
    this.projectAuthority = new SimulatorProjectArtifactCallbackAuthority({
      projectRoot: options.projectRoot,
      projectIdentity: options.projectIdentity,
      workspaceIdentity: options.workspaceIdentity,
      sceneId: options.sceneId,
      files: options.files,
      ...(options.artifactReferenceTtlMs === undefined
        ? {}
        : { artifactReferenceTtlMs: options.artifactReferenceTtlMs }),
      ...(options.maxArtifactReferences === undefined
        ? {}
        : { maxArtifactReferences: options.maxArtifactReferences }),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createArtifactReference
        ? { createArtifactReference: options.createArtifactReference }
        : {}),
      ...(options.createSceneCommitId
        ? { createSceneCommitId: options.createSceneCommitId }
        : {}),
    });
    const builder = createSimulatorBlocklyBuilderPort(options.builderService);
    const execution = new BlocklySimulatorBuildExecutionPort({
      projectRoot: options.projectRoot,
      projectIdentity: options.projectIdentity,
      sceneId: options.sceneId,
      activeProject: options.activeProject,
      reconciliation: options.reconciliation,
      builder,
      artifacts: {
        readLatest: async (
          projectIdentity: string,
          signal: AbortSignal,
        ): Promise<SimulatorSubappHostArtifactDescriptorV1> => (
          await this.projectAuthority.callbacks.readArtifact(
            { projectIdentity, artifactRevision: null },
            signal,
          )
        ),
      },
    });
    this.buildAuthority = new SimulatorBuildCallbackAuthority({
      projectIdentity: options.projectIdentity,
      sceneId: options.sceneId,
      execution,
      ...(options.maxBuildJobs === undefined
        ? {}
        : { maxJobs: options.maxBuildJobs }),
    });
    this.projectCallbacks = this.projectAuthority.callbacks;
    this.buildCallbacks = this.buildAuthority.callbacks;
  }

  snapshot(): SimulatorBuildProductCompositionSnapshot {
    return Object.freeze({
      closed: this.closed,
      project: this.projectAuthority.snapshot(),
      build: this.buildAuthority.snapshot(),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Cancel Build first so no execution can mint a new Artifact reference
    // after Project authority starts closing.
    this.buildAuthority.close();
    this.projectAuthority.close();
  }
}

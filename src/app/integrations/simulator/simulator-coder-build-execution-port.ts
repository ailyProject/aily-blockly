import type { SceneEditorDocumentV2 } from '@aily-project/scene-model';
import type { SceneArtifactRebuildRequest } from '@aily-project/simulator-protocol/scene';
import type { SimulatorSubappHostArtifactDescriptorV1 } from '@aily-project/simulator-protocol/host';
import type { SimulatorBuildExecutionObserver, SimulatorBuildExecutionPort } from './simulator-build-callback-authority';
import type { SimulatorActiveProjectBindingPort, SimulatorLatestArtifactDescriptorPort } from './simulator-build-execution-port';

export interface SimulatorCoderBuilderServicePort {
  buildForSimulation(projectPath: string, options: {
    requestId: string;
    graphSemanticRevision: string;
    sceneDocument: SceneEditorDocumentV2;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export interface CoderSimulatorBuildExecutionPortOptions {
  projectRoot: string;
  projectIdentity: string;
  sceneId?: string;
  activeProject: SimulatorActiveProjectBindingPort;
  builder: SimulatorCoderBuilderServicePort;
  artifacts: SimulatorLatestArtifactDescriptorPort;
  readCompileScene(revision: string, signal: AbortSignal): Promise<SceneEditorDocumentV2>;
}

/** Coder owns its saved source. A confirmed Scene binds compilation, but is
 * never permission to regenerate the user's C++ through Blockly or an Agent. */
export class CoderSimulatorBuildExecutionPort implements SimulatorBuildExecutionPort {
  private readonly sceneId: string;
  constructor(private readonly options: CoderSimulatorBuildExecutionPortOptions) {
    this.sceneId = options.sceneId ?? 'main';
    if (!options.projectRoot || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.projectIdentity)
      || typeof options.activeProject?.readActiveBinding !== 'function'
      || typeof options.activeProject.isSameProjectRoot !== 'function'
      || typeof options.builder?.buildForSimulation !== 'function'
      || typeof options.artifacts?.readLatest !== 'function'
      || typeof options.readCompileScene !== 'function') throw new TypeError('Coder Simulator build ports are invalid.');
  }

  async reconcileAndBuild(request: SceneArtifactRebuildRequest, observer: SimulatorBuildExecutionObserver,
    signal: AbortSignal): Promise<SimulatorSubappHostArtifactDescriptorV1> {
    this.requireCurrent(signal);
    if (request.projectIdentity !== this.options.projectIdentity || request.sceneId !== this.sceneId
      || request.sceneDocument.sceneId !== this.sceneId
      || request.sceneRevision !== request.sceneDocument.graphSemanticRevision
      || !['graph-semantic-changed', 'workspace-source-rebuild'].includes(request.reason)
      || (request.reason === 'workspace-source-rebuild' && request.baseSceneRevision !== request.sceneRevision)) {
      throw buildError('project-unavailable', 'Coder compilation does not match the confirmed Project Scene.');
    }
    observer.report('resolving', 100);
    observer.report('compiling', 500);
    try {
      const sceneDocument = await this.options.readCompileScene(request.sceneRevision, signal);
      this.requireCurrent(signal);
      if (sceneDocument.sceneId !== this.sceneId || sceneDocument.graphSemanticRevision !== request.sceneRevision) {
        throw new Error('The confirmed Coder Scene changed before compilation.');
      }
      observer.diagnostic?.('builder-started');
      // This promise includes normal save-all, the original request's physical
      // build settlement, and delivery verification. Abort alone is not done.
      await this.options.builder.buildForSimulation(this.options.projectRoot, {
        requestId: request.requestId, graphSemanticRevision: request.sceneRevision,
        sceneDocument, signal,
      });
      observer.diagnostic?.('builder-resolved');
      this.requireCurrent(signal);
    } catch (error) {
      throw mappedError(error, signal, 'compile-failed');
    }
    observer.report('staging', 900);
    try {
      this.requireCurrent(signal);
      observer.diagnostic?.('artifact-read-started');
      const artifact = await this.options.artifacts.readLatest(this.options.projectIdentity, signal);
      this.requireCurrent(signal);
      observer.diagnostic?.('artifact-read-resolved');
      return artifact;
    } catch (error) {
      throw mappedError(error, signal, 'artifact-staging-failed');
    }
  }

  private requireCurrent(signal: AbortSignal): void {
    if (signal.aborted) throw mappedError(signal.reason, signal, 'cancelled');
    const active = this.options.activeProject.readActiveBinding();
    if (!active || active.editorKind !== 'coder' || active.projectIdentity !== this.options.projectIdentity
      || active.sceneId !== this.sceneId
      || !this.options.activeProject.isSameProjectRoot(active.projectRoot, this.options.projectRoot)) {
      throw buildError('project-unavailable', 'The original Coder project is no longer active.');
    }
  }
}

function buildError(code: string, message: string): Error {
  return Object.assign(new Error(message), { simulatorBuildErrorCode: code });
}
function mappedError(error: unknown, signal: AbortSignal, fallback: string): Error {
  if (signal.aborted || (error && typeof error === 'object' && 'errorCode' in error && error.errorCode === 'build-cancelled')) {
    return buildError('cancelled', error instanceof Error ? error.message : 'Coder compilation was cancelled.');
  }
  if (error instanceof Error && 'simulatorBuildErrorCode' in error) return error;
  return buildError(fallback, error instanceof Error ? error.message : String(error));
}

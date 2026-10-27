import type {
  SimulatorBuildHostProviderAdapterOptions,
  SimulatorEditorHostProviderAdapterOptions,
  SimulatorEntitlementHostProviderAdapterOptions,
  SimulatorHostProviderDispatcherAdapter,
  SimulatorProjectHostProviderAdapter,
  SimulatorProjectHostProviderAdapterOptions,
} from '@aily-project/simulator-host-sdk';
import type { SimulatorCapturedProjectActivation } from './simulator-web-project-activation';
import type { SimulationArtifact } from '@aily-project/simulator-protocol/artifact';
import type { SimulatorSubappHostArtifactDescriptorV1, SimulatorSubappHostProjectContextSnapshotV1 } from '@aily-project/simulator-protocol/host';
import { SimulatorHostProviderOperationError } from '@aily-project/simulator-host-sdk';

/** Local project-read capability. This is never serialized or accepted from a
 * Shell; its TTL is captured from the original Host reference map. */
export interface SimulatorProjectReadArtifact {
  readonly kind: 'sealed-port';
  readonly scope: { readonly projectIdentity: string; readonly artifactRevision: string };
  readonly artifactId: string;
  open(scope: SimulatorProjectReadArtifact['scope'], signal?: AbortSignal): Promise<{
    readonly artifact: SimulationArtifact;
    readRange(path: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}
export interface SimulatorProjectReadAuthority {
  readonly activation: AbortSignal;
  readonly artifact: SimulatorProjectReadArtifact;
  requireCurrent(): void;
  readCurrentContext(signal: AbortSignal): Promise<SimulatorSubappHostProjectContextSnapshotV1>;
}
export interface SimulatorProjectReadAuthorityCapture {
  readonly context: SimulatorSubappHostProjectContextSnapshotV1;
  readonly descriptor: SimulatorSubappHostArtifactDescriptorV1;
  readonly artifact: SimulatorProjectReadArtifact;
  readonly activation: AbortSignal;
}

/** The dependencies are the original scope closures, not caller claims. */
export function captureSimulatorProjectReadAuthority(input: SimulatorProjectReadAuthorityCapture, original: {
  readonly activation: AbortSignal;
  readonly projectIdentity: string;
  readonly workspaceIdentity: string;
  requireCurrent(): void;
  readWorkspaceState(): Readonly<{ revision: number; code: string | null }>;
  captureValidity(descriptor: SimulatorSubappHostArtifactDescriptorV1): Readonly<{ requireCurrent(): void }>;
  readContext(signal: AbortSignal): Promise<SimulatorSubappHostProjectContextSnapshotV1>;
}): SimulatorProjectReadAuthority {
  const ownerCurrent = original.requireCurrent.bind(original), readState = original.readWorkspaceState.bind(original);
  const readContext = original.readContext.bind(original);
  ownerCurrent(); input.activation.throwIfAborted();
  if (input.context.projectIdentity !== original.projectIdentity || input.context.workspaceIdentity !== original.workspaceIdentity
    || input.context.activeSceneId !== 'main' || input.context.activeArtifactRevision !== input.descriptor.artifactRevision
    || input.artifact.scope.projectIdentity !== original.projectIdentity
    || input.artifact.scope.artifactRevision !== input.descriptor.artifactRevision
    || input.artifact.artifactId !== input.descriptor.artifactRevision) {
    throw new SimulatorHostProviderOperationError('conflict');
  }
  const validity = original.captureValidity(input.descriptor);
  const captured = readState(), activation = AbortSignal.any([original.activation, input.activation]);
  const requireCurrent = () => {
    ownerCurrent(); activation.throwIfAborted(); validity.requireCurrent();
    const current = readState();
    if (captured.revision !== current.revision || captured.code !== current.code) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
  };
  requireCurrent();
  return Object.freeze({ activation, artifact: input.artifact, requireCurrent,
    async readCurrentContext(signal: AbortSignal) {
      requireCurrent(); signal.throwIfAborted();
      const context = await readContext(AbortSignal.any([activation, signal]));
      requireCurrent(); signal.throwIfAborted(); return context;
    },
  });
}

/** One caller's original product authorities. The selected project/session is
 * borrowed; closing this scope never closes the application's project owner. */
export interface SimulatorCurrentProjectScope {
  readonly activation: SimulatorCapturedProjectActivation;
  readonly projectIdentity: string;
  readonly workspaceIdentity: string;
  readonly sceneId: 'main';
  /** Lazily created SDK validator over these same original callbacks. */
  readonly project: SimulatorProjectHostProviderAdapter;
  readonly callbacks: SimulatorProjectHostProviderAdapterOptions;
  readonly buildCallbacks: Pick<SimulatorBuildHostProviderAdapterOptions, 'requestArtifact' | 'subscribeProgress'>;
  readonly editorCallbacks: SimulatorEditorHostProviderAdapterOptions;
  readonly entitlementCallbacks: Pick<SimulatorEntitlementHostProviderAdapterOptions, 'requestLease' | 'subscribeStatus'>;
  readonly adapters: readonly SimulatorHostProviderDispatcherAdapter[];
  captureArtifactReadAuthority(input: SimulatorProjectReadAuthorityCapture): SimulatorProjectReadAuthority;
  requireCurrent(): void;
  /** Fences synchronously, then joins actual callback outcomes and cleanup.
   * A caller may bound its wait; rejection/pending retain this same scope. */
  close(): Promise<void>;
  snapshot(): Readonly<{
    closeRequested: boolean;
    closed: boolean;
    pendingOperations: number;
    retainedCleanupSteps: number;
    cleanupPending: boolean;
    WorkerPhysicalExitConfirmed: false;
    NodeBusinessACK: false;
    MainBusinessACK: false;
  }>;
}

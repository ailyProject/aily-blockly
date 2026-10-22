import type {
  SimulatorBuildHostProviderAdapterOptions,
  SimulatorEditorHostProviderAdapterOptions,
  SimulatorEntitlementHostProviderAdapterOptions,
  SimulatorHostProviderDispatcherAdapter,
  SimulatorProjectHostProviderAdapter,
  SimulatorProjectHostProviderAdapterOptions,
} from '@aily-project/simulator-host-sdk';
import type { SimulatorCapturedProjectActivation } from './simulator-web-project-activation';

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

/** Source persistence and derived output publication are independent facts. */
export interface ProjectRecoverySource {
  version: 1;
  kind: 'workspace' | 'saved-document';
  /** The selected primary source was completely captured; not a promise of runtime validity. */
  complete: true;
  loadFailed: boolean;
  partialCanvas: 'archived' | 'unavailable' | 'not-applicable';
}

export interface ProjectRecoveryActivationBlocked {
  reason: 'partial-canvas-unavailable' | 'source-changed' | 'source-busy';
  message: string;
}

/** Native host policy only; not an Agent-selected lifecycle override. */
export interface ProjectRecoveryCopyOptions { activation: 'retain-source'; }

export interface NativeRepairPrimaryProof {
  version: 1;
  kind: 'native-completed-fork-primary';
  project: string;
  sourceProject: string;
  requestId: string;
  abiHash: string;
  archive: string;
  origin: { sourceKind: 'workspace'; sourceAbiHash: string };
}

export interface ProjectSaveOutcome {
  projectSaved: boolean;
  generatedCodePublished: boolean;
  partial: boolean;
  code?: string;
  error?: string;
  /** Recovery copies establish ABS only after loading a fresh target runtime. */
  projectionPending?: boolean;
  recoverySource?: ProjectRecoverySource;
  recoveryArchive?: string;
  activationBlocked?: ProjectRecoveryActivationBlocked;
  activationDeferred?: { reason: 'isolated-repair-host' };
  nativePrimaryProof?: NativeRepairPrimaryProof;
}

/** An editor-owned immutable capture; publication must write the target only. */
export interface BlocklySaveAsSnapshot {
  publish(targetPath: string): Promise<ProjectSaveOutcome>;
  isCurrent(): boolean;
  /** Brief input fence for activation only; does not acquire a writer lease. */
  freezeForActivation?(): () => void;
  readonly activationBlocked?: ProjectRecoveryActivationBlocked;
  dispose(): void;
}

export interface ProjectSaveAsOutcome extends ProjectSaveOutcome {
  sourceProject: string;
  project: string;
  activated: boolean;
  warnings?: string[];
}

export function projectSaveOutcomeError(outcome: ProjectSaveOutcome): Error & ProjectSaveOutcome {
  return Object.assign(new Error(outcome.error || (outcome.projectSaved
    ? 'Project file is saved, but generated code publication is incomplete.'
    : 'Project file was not saved.')), outcome);
}

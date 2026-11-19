import { sha256Hex } from '../../../utils/crypto.utils';
import type { ProjectSaveAsOutcome, ProjectRecoveryActivationBlocked, NativeRepairPrimaryProof } from './project-save-outcome';
import type { ProjectFileWriteResult } from '@core/platform/public-api';

export interface SavedRecoveryTarget {
  project: string;
  sourceProject: string;
  abiHash: string;
  recoverySource: NonNullable<ProjectSaveAsOutcome['recoverySource']>;
  recoveryArchive: string;
  nativePrimaryProof?: NativeRepairPrimaryProof;
}

export interface SavedRecoveryTargetAdmission extends SavedRecoveryTarget {
  ok: true;
  operation: 'project_abi_check';
  scope: 'saved-recovery-project';
  pendingMutation: false;
  loadStatus: { project: string; ready: boolean; state: string; error?: string };
  unsavedLibraryChanges: boolean;
  libraryState: { dirty: boolean; busy: boolean };
}

export interface SavedRecoveryTargetReload {
  ok: boolean;
  project: string;
  ready: boolean;
  loadStatus?: { project: string; ready: boolean; state: string; error?: string };
  activationBlocked?: ProjectRecoveryActivationBlocked;
  message?: string;
  recoveryArchive?: string;
  recoveryReload?: { version: 1; project: string; source: 'saved-document'; beforeAbiHash: string; afterAbiHash: string; ready: boolean };
}

/** Process-local facts from an actual successful disk-primary copy. A copied
 * archive, project name or caller flag cannot create this capability. It only
 * admits managed dependency repair, never ABI writes, ABS apply or a reload of
 * an unverified source. Restarting the host intentionally forgets this map. */
export class ProjectRecoveryTargets {
  private readonly targets = new Map<string, SavedRecoveryTarget>();
  private key(project: string) {
    const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
    return window['platform']?.isWindows ? normalized.toLowerCase() : normalized;
  }

  has(project: string): boolean { return this.targets.has(this.key(project)); }

  async remember(outcome: ProjectSaveAsOutcome, assertCurrent: () => void): Promise<void> {
    if (!outcome.projectSaved || outcome.recoverySource?.kind !== 'saved-document'
      || outcome.recoverySource.complete !== true || !outcome.recoveryArchive) return;
    const fs = window['fs'], abi = `${outcome.project}/project.abi`;
    const text = fs.readFileSync(abi, 'utf8'), abiHash = `sha256:${await sha256Hex(text)}`;
    assertCurrent();
    if (fs.readFileSync(abi, 'utf8') !== text || !fs.existsSync(outcome.recoveryArchive)) {
      throw new Error('The saved recovery target changed before dependency-repair admission could be recorded.');
    }
    this.targets.set(this.key(outcome.project), { project: outcome.project, sourceProject: outcome.sourceProject,
      abiHash, recoverySource: { ...outcome.recoverySource }, recoveryArchive: outcome.recoveryArchive });
  }

  /** Only openIndependentRepairTarget supplies the trusted native admission.
   * Workspace origin stays workspace; the archive proves C's own saved primary. */
  async rememberNativePrimary(outcome: ProjectSaveAsOutcome & { targetAbiHash?: string }, assertCurrent: () => void): Promise<void> {
    const proof = outcome.nativePrimaryProof, hashPattern = /^sha256:[a-f0-9]{64}$/;
    if (!outcome.projectSaved || outcome.recoverySource?.kind !== 'workspace' || outcome.recoverySource.complete !== true
      || proof?.version !== 1 || proof.kind !== 'native-completed-fork-primary'
      || proof.project !== outcome.project || proof.sourceProject !== outcome.sourceProject || proof.project === proof.sourceProject
      || proof.archive !== outcome.recoveryArchive || !/^[A-Za-z0-9_-]{8,96}$/.test(proof.requestId)
      || !hashPattern.test(proof.abiHash) || proof.abiHash !== outcome.targetAbiHash
      || proof.origin?.sourceKind !== 'workspace' || !hashPattern.test(proof.origin.sourceAbiHash)) {
      throw new Error('The native saved-target primary admission is incomplete.');
    }
    const path = window['path'], fs = window['fs'];
    const relative = path.relative(path.resolve(outcome.project), path.resolve(proof.archive)).replace(/\\/g, '/');
    if (!/^\.aily\/recovery-primary\/[a-f0-9]{64}\.json$/.test(relative)) throw new Error('The native primary archive is outside its exact target storage.');
    const text = fs.readFileSync(`${outcome.project}/project.abi`, 'utf8');
    const archiveText = fs.readFileSync(proof.archive, 'utf8'), archive = JSON.parse(archiveText);
    const actual = `sha256:${await sha256Hex(text)}`; assertCurrent();
    if (actual !== proof.abiHash || archive?.version !== 1 || archive.kind !== proof.kind || archive.project !== proof.project
      || archive.sourceProject !== proof.sourceProject || archive.requestId !== proof.requestId || archive.primary?.text !== text
      || archive.primary.hash !== actual || archive.origin?.sourceKind !== 'workspace'
      || archive.origin.sourceAbiHash !== proof.origin.sourceAbiHash || fs.readFileSync(`${outcome.project}/project.abi`, 'utf8') !== text
      || fs.readFileSync(proof.archive, 'utf8') !== archiveText) throw new Error('The native primary archive does not prove this saved target.');
    this.targets.set(this.key(outcome.project), { project: outcome.project, sourceProject: outcome.sourceProject,
      abiHash: actual, recoverySource: { ...outcome.recoverySource }, recoveryArchive: proof.archive,
      nativePrimaryProof: { ...proof, origin: { ...proof.origin } } });
  }

  /** Advance an existing copy capability only along an acknowledged normalizer
   * CAS. This cannot register arbitrary current bytes or create a new target. */
  async advanceNormalization(project: string, transition: { beforeAbiHash: string; afterAbiHash: string;
    publication?: ProjectFileWriteResult }, assertCurrent: () => void): Promise<boolean> {
    const key = this.key(project), saved = this.targets.get(key);
    if (!saved) return false;
    assertCurrent();
    const { beforeAbiHash, afterAbiHash, publication } = transition;
    if (saved.abiHash !== beforeAbiHash || publication?.status !== 'COMMITTED'
      || publication.hash !== afterAbiHash || publication.backupHash !== beforeAbiHash) {
      throw new Error('Recovery normalization does not continue the exact existing saved primary.');
    }
    const fs = window['fs'], file = `${project}/project.abi`, text = fs.readFileSync(file, 'utf8');
    const actual = `sha256:${await sha256Hex(text)}`;
    assertCurrent();
    if (this.targets.get(key) !== saved || actual !== afterAbiHash || fs.readFileSync(file, 'utf8') !== text
      || !fs.existsSync(saved.recoveryArchive)) {
      throw new Error('The recovery target changed after normalization; external bytes were not rebound.');
    }
    this.targets.set(key, { ...saved, abiHash: afterAbiHash });
    return true;
  }

  async inspect(project: string, assertCurrent: () => void): Promise<SavedRecoveryTarget | null> {
    const key = this.key(project), saved = this.targets.get(key);
    if (!saved) return null;
    assertCurrent();
    const fs = window['fs'], file = `${project}/project.abi`;
    if (!fs.existsSync(file) || !fs.existsSync(saved.recoveryArchive)) { this.targets.delete(key); return null; }
    const text = fs.readFileSync(file, 'utf8'), hash = `sha256:${await sha256Hex(text)}`;
    assertCurrent();
    if (this.targets.get(key) !== saved || hash !== saved.abiHash || fs.readFileSync(file, 'utf8') !== text) {
      this.targets.delete(key); return null;
    }
    return { ...saved, recoverySource: { ...saved.recoverySource } };
  }
}

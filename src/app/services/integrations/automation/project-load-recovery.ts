import { inspectProjectDiskRecovery } from '@domain/project/public-api';
import { assertGenerationRequest } from '../../../integrations/blockly/abs/abs-generation-protocol';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { openAbsHostStorage } from '../../../integrations/blockly/abs/abs-host-storage';
import { readAbsRecoveryLineage } from '../../../integrations/blockly/abs/abs-recovery-lineage';

export interface FailedProjectLoadStatus { ready: boolean; state: string; error?: string }
interface VerifiedSavedRecoveryTarget { project: string; sourceProject: string; abiHash: string; recoveryArchive: string }

/** Navigation failure is not authority to alter a partial canvas or its files. */
export function projectLoadFailureGuidance(project: string, status: FailedProjectLoadStatus, blockly = true) {
  const failed = blockly && !status.ready && (!!status.error || ['failed', 'error'].includes(status.state));
  return failed ? {
    nextAction: { tool: 'project_recover', input: { project, action: 'inspect' } },
    guidance: 'Inspect this failed load with project_recover(action="inspect") and follow the verified recovery or managed dependency route it returns. Preserve the source, partial view, ABS draft, map and protection. Do not save a partial canvas, close/reload in a loop, edit ABI/map or ask the user to repair internal files. An already independent target must not be forked again.',
  } : {
    nextAction: { tool: 'app_info', input: {} },
    guidance: 'Observe the current host and navigation outcome before another action. A rejected, pending or cancelled navigation is not permission to modify source state, close another view, delete locks or force recovery.',
  };
}

/** A failed-load inspection does not read generation/private state or serialize
 * an incomplete canvas. It only offers a disk-primary copy of observed bytes. */
export async function inspectFailedProjectLoad(project: string, loadStatus: FailedProjectLoadStatus,
  input: Record<string, unknown>, assertCurrent: () => void,
  inspectSavedTarget?: () => Promise<VerifiedSavedRecoveryTarget | null>) {
  assertGenerationRequest(input);
  if (input['action'] !== 'inspect' || Object.keys(input).some(key =>
    !['version', 'requestId', 'action'].includes(key) && input[key] !== undefined)) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'Failed-load inspection accepts only the current inspect request. It does not consume generation authority.');
  }
  let disk: Awaited<ReturnType<typeof inspectProjectDiskRecovery>>;
  let saved: VerifiedSavedRecoveryTarget | null = null;
  let lineage: Awaited<ReturnType<typeof readAbsRecoveryLineage>> = null;
  try {
    disk = await inspectProjectDiskRecovery(project, assertCurrent);
    assertCurrent(); saved = await inspectSavedTarget?.() ?? null; assertCurrent();
    if (window['fs']?.projectSyncStorageVersion === 2) {
      lineage = await readAbsRecoveryLineage(await openAbsHostStorage(project, assertCurrent), project);
      assertCurrent();
    }
  }
  catch (error) {
    return { ok: false, operation: 'abs_recovery', project,
      code: typeof (error as any)?.code === 'string' ? (error as any).code : 'PROJECT_RECOVERY_INSPECTION_FAILED',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      nextAction: { tool: 'app_info', input: {} },
      guidance: 'The current source could not be inspected without uncertainty. Preserve the source and candidate; observe app_info or the existing operation receipt before another recovery action. No writer was bypassed and no source files were changed.' };
  }
  const independent = disk.abi === 'available' && saved?.project === project && saved.abiHash === disk.hashes.abi;
  const loadRecovery = { version: 1, source: 'saved-document', loadStatus: { ...loadStatus }, disk,
    pendingMutation: false, ...(independent ? { scope: 'saved-recovery-project', alreadyIndependent: true,
      recoveryTarget: { project, sourceProject: saved.sourceProject, abiHash: saved.abiHash, recoveryArchive: saved.recoveryArchive } }
      : {}), ...(lineage ? { lineage, alreadyIndependent: true } : {}),
    offer: { action: 'recover_project', sameProject: true, candidateApplied: false } };
  const common = { operation: 'abs_recovery', project, requiresReload: false,
    receipt: { version: 2, requestId: input.requestId, action: 'inspect' }, diagnostics: { loadRecovery } };
  if (independent) return { ...common, ok: true,
    nextAction: { tool: 'project_recover', input: { project, action: 'recover_project' } },
    guidance: 'Recover this same project through the host-owned operation. Its current document and partial view are preserved and verified before reopening; no candidate is applied. A persisted relationship is not a write permission. Do not fork again or ask the user to open a copy or confirm readiness. If dependencies are unavailable, use the reported managed dependency route.' };
  return disk.abi === 'available'
    ? { ...common, ok: true,
      nextAction: { tool: 'project_recover', input: { project, action: 'recover_project' } },
      guidance: 'Call recover_project to converge the exact interrupted transaction and reload this same project from verified saved content. The host preserves the partial view and complete candidate. This does not apply the candidate; after verified readiness, prepare it against the fresh trusted generation. Do not create another project or ask the user to confirm readiness.' }
    : { ...common, ok: false, code: 'PROJECT_RECOVERY_SOURCE_UNAVAILABLE',
      message: `The saved project.abi is ${disk.abi}; no complete recovery source was invented.`,
      nextAction: { tool: 'project_recover', input: { project, action: 'recover_project' } },
      guidance: 'The host may restore only an independently verified operation snapshot or committed transaction. Invoke recover_project once; it retains damaged bytes and refuses to invent a source. Never use the partial canvas as the primary or ask the user to open a copy.' };
}

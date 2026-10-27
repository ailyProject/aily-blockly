import { inspectProjectDiskRecovery } from '@domain/project/public-api';
import { assertGenerationRequest } from '../../../integrations/blockly/abs/abs-generation-protocol';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';

export interface FailedProjectLoadStatus { ready: boolean; state: string; error?: string }
interface VerifiedSavedRecoveryTarget { project: string; sourceProject: string; abiHash: string; recoveryArchive: string }

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
  try {
    disk = await inspectProjectDiskRecovery(project, assertCurrent);
    assertCurrent(); saved = await inspectSavedTarget?.() ?? null; assertCurrent();
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
      : disk.abi === 'available' ? { offer: { action: 'fork' } } : {}) };
  const common = { operation: 'abs_recovery', project, requiresReload: false,
    receipt: { version: 2, requestId: input.requestId, action: 'inspect' }, diagnostics: { loadRecovery } };
  if (independent) return { ...common, ok: true,
    nextAction: { tool: 'project_status', input: { project } },
    guidance: 'This is already a verified independent saved-primary recovery target. Do not fork again. Read project_status and the load error to identify missing or invalid dependencies; repair them with the managed lib_add or lib_install_local tools, whose admission rechecks this saved primary. Successful managed installation reloads this same target. Then continue fresh ABS validation and apply. The original source, its view and protection remain unchanged; never edit ABI/map or clear locks to bypass failed loading.' };
  return disk.abi === 'available'
    ? { ...common, ok: true,
      nextAction: { tool: 'project_recover', input: { project, action: 'fork' } },
      guidance: 'This project never completed loading; its canvas is not a complete program. Call project_recover(action="fork") to preserve the complete saved project.abi as the independent target primary, keeping the partial canvas and original ABS/map in a separate archive. No source file, lock or guard is cleared. Continue on the returned target only after its runtime is ready; do not save or apply over the failed source or edit internal ABI/map records.' }
    : { ...common, ok: false, code: 'PROJECT_RECOVERY_SOURCE_UNAVAILABLE',
      message: `The saved project.abi is ${disk.abi}; no complete recovery source was invented.`,
      guidance: 'Keep the original project and partial view intact. Read the available saved source/backups and dependency diagnostics before choosing a recoverable source. Do not replace it with a half-loaded canvas, clear locks or claim a completed recovery.' };
}

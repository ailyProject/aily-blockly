import { readProjectViewOpenFailure } from '@domain/project/public-api';

/** Only offer the existing closed-source copy route when its admission can
 * preserve this saved source. A live owner/writer is never bypassed by a fork. */
export function projectViewRecoveryFailure(error: unknown, project: string,
  context: { mode: string; hasOpenView: boolean; hasSavedDocument(): boolean }) {
  const view = readProjectViewOpenFailure(error, project);
  if (!view) return undefined;
  let copy = false;
  if (view.ownership.state === 'unknown' && context.mode === 'blockly' && !context.hasOpenView) {
    try { copy = context.hasSavedDocument(); } catch { /* No verified saved-source offer. */ }
  }
  return { ok: false, operation: 'project_open', project, code: view.code, reason: 'project_view_unavailable',
    sourceViewPreserved: true, projectView: view,
    message: error instanceof Error ? error.message : 'Project view acquisition was not confirmed.',
    nextAction: copy ? { tool: 'project_recover', input: { project, action: 'open' } }
      : { tool: 'app_info', input: {} },
    guidance: copy
      ? 'The view owner could not be confirmed. Use project_recover(action="open") for a checked independent copy of the complete saved project. It holds source-file publication exclusion, verifies saved snapshots and excludes build/runtime outputs; it never releases an existing writer or owner record. Follow its actual receipt; do not delete locks, force open or treat saved disk data as unsaved work from another window.'
      : 'Keep the source, candidate and existing view intact. Observe app_info and the actual owner/operation before further navigation. Do not force open, delete locks, fork around a confirmed live owner, replay an uncertain mutation or ask the user to repair internal state. A different active view is not closed by this failed open.' };
}

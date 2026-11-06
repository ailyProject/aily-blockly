import { readProjectViewOpenFailure } from '@domain/project/public-api';

/** Opening the original directory still uses the normal owner admission.
 * A live owner/writer never authorizes another recovery project. */
export function projectViewRecoveryFailure(error: unknown, project: string,
  context: { mode: string; hasOpenView: boolean; hasSavedDocument(): boolean }) {
  const view = readProjectViewOpenFailure(error, project);
  if (!view) return undefined;
  let canOpenSameProject = false;
  if (view.ownership.state === 'unknown' && context.mode === 'blockly' && !context.hasOpenView) {
    try { canOpenSameProject = context.hasSavedDocument(); } catch { /* No verified saved-source offer. */ }
  }
  return { ok: false, operation: 'project_open', project, code: view.code, reason: 'project_view_unavailable',
    sourceViewPreserved: true, projectView: view,
    message: error instanceof Error ? error.message : 'Project view acquisition was not confirmed.',
    nextAction: canOpenSameProject ? { tool: 'project_recover', input: { project, action: 'open' } }
      : { tool: 'app_info', input: {} },
    guidance: canOpenSameProject
      ? 'The view owner could not be confirmed. Use project_recover(action="open") to inspect and open this same project through its normal ownership checks. It never copies the project, releases another writer or bypasses an owner record. Follow the original request observation; do not delete locks, force open or treat saved disk data as unsaved work from another window.'
      : 'Keep the source, candidate and existing view intact. Observe app_info and the actual owner/operation before further navigation. Do not force open, delete locks, fork around a confirmed live owner, replay an uncertain mutation or ask the user to repair internal state. A different active view is not closed by this failed open.' };
}

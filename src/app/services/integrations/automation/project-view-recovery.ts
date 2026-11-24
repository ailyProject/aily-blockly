import { readProjectViewOpenFailure } from '@domain/project/public-api';

/** Opening the original directory still uses the normal owner admission.
 * A live owner/writer never authorizes another recovery project. */
export function projectViewRecoveryFailure(error: unknown, project: string) {
  const view = readProjectViewOpenFailure(error, project);
  if (!view) return undefined;
  return { ok: false, operation: 'project_open', project, code: view.code, reason: 'project_view_unavailable',
    sourceViewPreserved: true, projectView: view,
    message: error instanceof Error ? error.message : 'Project view acquisition was not confirmed.',
    nextAction: { tool: 'app_info', input: {} },
    guidance: 'Check the current host view with app_info. Keep the original project and candidate intact while view ownership remains unconfirmed.' };
}

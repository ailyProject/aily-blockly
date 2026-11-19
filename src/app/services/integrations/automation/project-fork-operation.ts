import type { ProjectService } from '@domain/project/public-api';

/** Automation recovery never creates an independent logical project. Explicit
 * user Save As remains owned by the domain/UI and is not an error fallback. */
export async function forkProject(service: Pick<ProjectService, 'currentProjectPath'>,
  requestedProject?: string, _params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const project = service.currentProjectPath || requestedProject || '';
  return { ok: false, operation: 'project_fork', project, sourceProject: project,
    projectSaved: false, activated: false, candidateApplied: false, createdProject: false,
    code: 'PROJECT_RECOVERY_IN_PLACE_REQUIRED',
    message: 'Internal recovery must retain this project. No independent project was created.',
    ...(project ? { nextAction: { tool: 'project_recover', input: { project, action: 'inspect' } } } : {}),
    guidance: 'Preserve the candidate and inspect the same project. The host stores recovery versions inside its private backup storage and performs any required reload automatically. Do not create or ask the user to open another project. Explicit user Save As is a separate UI operation.' };
}

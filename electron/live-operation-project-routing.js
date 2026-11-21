const path = require('node:path');
const fs = require('node:fs');
const { rootAttachment } = require('./project-file-lock-owner');

const parameterScopedProjects = new Set([
  'project_fork_status', 'project_recovery_open', 'project_save_status', 'project_publication_status',
  'project_board_environment_settle', 'project_navigation_status', 'abs_admission_status',
]);

/** Recovery observation names its protected source in params.project. The
 * currently active canvas may already be the recovered target, so using it as
 * an implicit path would change the request rather than route it. Explicit
 * caller paths remain intact for the renderer's normal exact-project check. */
function routeLiveOperationProject(operation, requestedPath, currentProject, resolve = path.resolve, params) {
  const stateObservation = operation === 'abs_recovery' && params?.action === 'observe_state';
  const parameterScoped = stateObservation || parameterScopedProjects.has(operation);
  const explicitPath = (stateObservation || operation === 'abs_admission_status') && !path.isAbsolute(requestedPath || '') ? '' : requestedPath;
  const project = explicitPath ? resolve(explicitPath) : parameterScoped ? '' : (currentProject || '');
  const originalPublication = isOriginalPublicationRequest(operation, params);
  const attachment = originalPublication ? originalPublicationAttachment(project, currentProject) : undefined;
  return {
    path: project,
    parameterScoped,
    ...(originalPublication ? { originalPublication: true } : {}),
    ...(attachment ? { originalAdmissionAttachment: attachment } : {}),
  };
}

function routeProjectReload(requestedPath, currentProject, scoped, resolve = path.resolve) {
  const target = requestedPath ? resolve(requestedPath) : currentProject;
  return {
    path: target,
    operation: scoped || (currentProject && resolve(currentProject) === target) ? 'project_reload' : 'project_open',
    canFallbackToOpen: !scoped,
  };
}

function projectLifecycleRequestRejection(snapshot, rendererGeneration) {
  if (snapshot === undefined) return null;
  const valid = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && Object.keys(snapshot).every(key => ['version', 'sourceProject', 'rendererGeneration'].includes(key))
    && snapshot.version === 1 && Number.isSafeInteger(snapshot.rendererGeneration) && snapshot.rendererGeneration > 0
    && (snapshot.sourceProject === null || (typeof snapshot.sourceProject === 'string'
      && snapshot.sourceProject.trim().length > 0 && path.isAbsolute(snapshot.sourceProject)));
  if (valid && snapshot.rendererGeneration === rendererGeneration) return null;
  return { ok: false, code: valid ? 'PROJECT_LIFECYCLE_CONTEXT_CHANGED' : 'PROJECT_LIFECYCLE_CONTEXT_INVALID',
    commandDispatched: false, stateChanged: false, candidateApplied: false, requiresUserAction: false,
    message: 'The project lifecycle context changed before dispatch; observe this host again.' };
}

/** The renderer may settle a refusal after navigation, but only on the
 * physical project the main process verified while routing the command. */
function originalPublicationAttachment(requested, active) {
  if (!requested || !active) return undefined;
  try {
    const original = fs.realpathSync.native(requested), current = fs.realpathSync.native(active);
    const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (compare(original) === compare(current)) return rootAttachment(original);
  } catch { /* No original attachment is proven. */ }
}

function isOriginalPublicationRequest(operation, params) {
  return operation === 'abs_apply' && params?.version === 2
    || operation === 'blocks_set_state' && params?.version === 2 && params.action === 'update'
    || ['project_save', 'blocks_tidy'].includes(operation) && params?.saveRequest?.version === 2;
}

module.exports = { routeLiveOperationProject, routeProjectReload, projectLifecycleRequestRejection };

const path = require('node:path');

const parameterScopedProjects = new Set(['project_fork_status', 'project_recovery_open', 'project_save_status']);

/** Recovery observation names its protected source in params.project. The
 * currently active canvas may already be the recovered target, so using it as
 * an implicit path would change the request rather than route it. Explicit
 * caller paths remain intact for the renderer's normal exact-project check. */
function routeLiveOperationProject(operation, requestedPath, currentProject, resolve = path.resolve) {
  const parameterScoped = parameterScopedProjects.has(operation);
  return {
    path: requestedPath ? resolve(requestedPath) : parameterScoped ? '' : (currentProject || ''),
    parameterScoped,
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

module.exports = { routeLiveOperationProject, projectLifecycleRequestRejection };

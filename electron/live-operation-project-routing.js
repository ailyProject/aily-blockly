const path = require('node:path');

const parameterScopedProjects = new Set(['project_fork_status', 'project_recovery_open']);

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

module.exports = { routeLiveOperationProject };

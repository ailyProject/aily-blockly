// Optional build lifecycle adapter. The command runner owns cancellation; the
// child module owns the build marker contract in development and packaged apps.
const path = require('node:path');

function createBuildWorkspaceSupervisor(projectPath) {
  if (projectPath === undefined) return undefined;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('Build workspace must be an absolute project path.');
  }
  const childRoot = process.env.AILY_CHILD_PATH || path.join(__dirname, '..', 'child');
  return require(path.join(childRoot, 'scripts/build-workspace-lease.js'))
    .createBuildWorkspaceSupervisor(projectPath);
}

module.exports = { createBuildWorkspaceSupervisor };

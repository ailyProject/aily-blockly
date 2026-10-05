const path = require('path');

const cancelledScopes = new WeakMap();

function normalizeProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readProjectTaskScope(options) {
  const { projectPath, projectSessionId } = options;
  if (projectPath === undefined && projectSessionId === undefined) return null;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)
      || typeof projectSessionId !== 'string' || !projectSessionId.trim()) {
    throw new Error('Invalid project task scope.');
  }
  return { projectPath: normalizeProjectPath(projectPath), projectSessionId };
}

function scopeKey(scope) {
  return JSON.stringify([scope.projectPath, scope.projectSessionId]);
}

function assertProjectTaskActive(owner, options) {
  const scope = readProjectTaskScope(options);
  if (scope && cancelledScopes.get(owner)?.has(scopeKey(scope))) {
    throw new Error('PROJECT_TASK_CANCELLED');
  }
  return scope;
}

function cancelProjectTaskScope(owner, options) {
  const scope = readProjectTaskScope(options);
  if (!scope) throw new Error('Project task scope is required.');
  let cancelled = cancelledScopes.get(owner);
  if (!cancelled) {
    cancelled = new Set();
    cancelledScopes.set(owner, cancelled);
    owner.once?.('destroyed', () => cancelledScopes.delete(owner));
  }
  cancelled.add(scopeKey(scope));
  return scope;
}

function matchesProjectTask(entry, owner, projectPath, projectSessionId) {
  if (entry.ownerWebContents !== owner) return false;
  const scope = readProjectTaskScope(entry);
  if (scope) return scope.projectPath === normalizeProjectPath(projectPath)
    && scope.projectSessionId === projectSessionId;
  const legacyProject = entry.buildWorkspacePath || entry.cwd;
  return !!legacyProject && normalizeProjectPath(legacyProject) === normalizeProjectPath(projectPath);
}

module.exports = { assertProjectTaskActive, cancelProjectTaskScope, matchesProjectTask };

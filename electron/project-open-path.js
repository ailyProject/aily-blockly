'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function projectDirectoryForFile(filename, cwd = process.cwd()) {
  if (typeof filename !== 'string' || !/\.(abi|aci|ino)$/i.test(filename)) return null;
  const resolved = path.resolve(cwd, filename);
  // Keep the selected sketch until the renderer checks its enclosing project.
  try { return fs.statSync(resolved).isFile() ? (/\.ino$/i.test(resolved) ? resolved : path.dirname(resolved)) : null; }
  catch { return null; }
}

function projectDirectoryFromArgs(argv, cwd = process.cwd()) {
  for (const arg of argv) {
    if (arg.startsWith('--open-project=')) {
      const target = path.resolve(cwd, arg.slice('--open-project='.length));
      try { if (fs.statSync(target).isDirectory()) return target; } catch { /* Try files below. */ }
      const root = projectDirectoryForFile(target, cwd);
      if (root) return root;
    }
  }
  for (const arg of argv) {
    const root = projectDirectoryForFile(arg, cwd);
    if (root) return root;
  }
  return null;
}

/** Main grants the cold-start record to one dispatched route in one renderer. */
function createProjectStartupOpen() {
  let pending;
  const key = project => process.platform === 'win32' ? path.resolve(project).toLowerCase() : path.resolve(project);
  const current = (ticket, project, generation) => !!pending?.generation && pending.generation === generation
    && pending.request.startupTicket === ticket && typeof project === 'string' && path.isAbsolute(project)
    && key(pending.request.projectPath) === key(project);
  return {
    stage(restore) {
      const request = { projectPath: restore.project, startupTicket: randomUUID() };
      pending = { request, restore };
      return request;
    },
    dispatch(request, generation) {
      if (pending?.request !== request || pending.generation || !Number.isSafeInteger(generation) || generation < 1) return false;
      pending.generation = generation;
      return true;
    },
    isCurrent: current,
    consume(ticket, project, generation) {
      if (!current(ticket, project, generation)) return null;
      const { restore } = pending;
      pending = undefined;
      return restore;
    },
    invalidate() { pending = undefined; },
  };
}

module.exports = { projectDirectoryForFile, projectDirectoryFromArgs, createProjectStartupOpen };

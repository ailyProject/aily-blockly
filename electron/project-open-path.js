'use strict';
const fs = require('node:fs');
const path = require('node:path');

function projectDirectoryForFile(filename, cwd = process.cwd()) {
  if (typeof filename !== 'string' || !/\.(abi|aci|ino)$/i.test(filename)) return null;
  const resolved = path.resolve(cwd, filename);
  try { return fs.statSync(resolved).isFile() ? path.dirname(resolved) : null; }
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

module.exports = { projectDirectoryForFile, projectDirectoryFromArgs };

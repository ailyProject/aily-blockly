const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = function projectViewLocks({ pid = process.pid, processState } = {}) {
  const filename = path.resolve(__dirname, '../../../electron/project-lock.js'), localRequire = createRequire(filename);
  const nativeProcess = { pid, execPath: process.execPath, platform: process.platform,
    kill: target => {
      if (!processState) return process.kill(target, 0);
      const state = processState(target);
      if (state === true) return;
      throw Object.assign(new Error('fixture process state'), { code: state === false ? 'ESRCH' : 'EPERM' });
    } };
  const requireFixture = name => name === 'electron' ? { app: { getVersion: () => 'fixture-version' } }
    : name === 'child_process' ? { ...localRequire(name), execFileSync: () => `ExecutablePath=${process.execPath}\n` } : localRequire(name);
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', fs.readFileSync(filename, 'utf8'))(
    requireFixture, instance, instance.exports, path.dirname(filename), filename, nativeProcess);
  return instance.exports;
};

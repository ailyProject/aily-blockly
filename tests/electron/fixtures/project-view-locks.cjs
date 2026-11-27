const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = function projectViewLocks({ pid = process.pid, processState } = {}) {
  const filename = path.resolve(__dirname, '../../../electron/project-lock.js'), localRequire = createRequire(filename);
  const childScripts = path.resolve(__dirname, '../../../child/scripts');
  const nativeProcess = { pid, execPath: process.execPath, platform: process.platform,
    kill: target => {
      if (!processState) return process.kill(target, 0);
      const state = processState(target);
      if (state === true) return;
      throw Object.assign(new Error('fixture process state'), { code: state === false ? 'ESRCH' : 'EPERM' });
    } };
  const requireFixture = name => name === 'electron' ? { app: { getVersion: () => 'fixture-version' } }
    : name === './child-script-path' ? { childScriptPath: filename => path.join(childScripts, filename) }
    : name === path.join(childScripts, 'process-state.js') ? (() => {
      const state = { exports: {} };
      new Function('module', 'exports', 'process', fs.readFileSync(localRequire.resolve(name), 'utf8'))(state, state.exports, nativeProcess);
      return state.exports;
    })() : localRequire(name);
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', fs.readFileSync(filename, 'utf8'))(
    requireFixture, instance, instance.exports, path.dirname(filename), filename, nativeProcess);
  return instance.exports;
};

if (require.main === module) {
  const locks = module.exports();
  process.on('message', () => {});
  process.send(locks.tryAcquireLock(process.argv[2]));
}

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Configure a real OS denial. The production rename syscall raises the error.
// Windows uses its real file handle semantics; macOS uses an immutable staging directory.
function holdPublication(mode, transientDenials = 2) {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Native publication locking requires Windows or macOS');
  const rename = fs.renameSync;
  const observed = [];
  let lockedSource = null, handle = null, armed = true, attempts = 0;
  const release = () => {
    if (handle !== null) { fs.closeSync(handle); handle = null; }
    if (lockedSource && process.platform === 'darwin' && fs.existsSync(lockedSource)) {
      execFileSync('/usr/bin/chflags', ['nouchg', lockedSource]);
    }
    lockedSource = null;
  };
  fs.renameSync = (source, destination, ...args) => {
    const publishing = path.basename(String(source)).startsWith('.staging-');
    if (publishing && mode === 'remove-runtime') {
      const result = rename(source, destination, ...args);
      fs.rmSync(path.join(destination, 'source/server/index.js'));
      return result;
    }
    if (publishing) {
      attempts++;
      if (armed) {
        armed = false; lockedSource = source;
        if (process.platform === 'win32') handle = fs.openSync(path.join(source, 'source/package.json'), 'r');
        else execFileSync('/usr/bin/chflags', ['uchg', source]);
      }
    }
    try { return rename(source, destination, ...args); }
    catch (error) {
      if (publishing) {
        observed.push({ code: error.code, errno: error.errno, syscall: error.syscall, message: error.message });
        if (mode === 'transient' && observed.length >= transientDenials) release();
      }
      throw error;
    }
  };
  return {
    release,
    stats: () => ({ mode, attempts, observed: [...observed] }),
    stop() { fs.renameSync = rename; release(); },
  };
}

module.exports = { holdPublication };

'use strict';
// Owned test process: no npm/network/package mutation, only isolated test files.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [mode, pidsFile] = process.argv.slice(2);
if (mode === 'normal' || mode === 'failure') {
  setTimeout(() => process.exit(mode === 'normal' ? 0 : 7), 100);
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(pidsFile, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
}

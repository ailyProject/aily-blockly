'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

async function holdWindowsFileWithoutDeleteSharing(filename) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$file = [IO.File]::Open($env:AILY_FIXTURE_SHARED_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    "try { [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }",
  ].join('; ')], {
    env: { ...process.env, AILY_FIXTURE_SHARED_FILE: filename }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const ready = await Promise.race([once(lines, 'line').then(([line]) => line), closed.then(([code]) => `exit ${code}`)]);
  if (ready !== 'ready') {
    child.stdin.end();
    await closed;
    throw new Error(`The Windows file sharing fixture did not start: ${ready}`);
  }
  return async () => {
    if (!child.stdin.writableEnded) child.stdin.end('\n');
    await closed;
  };
}

module.exports = { holdWindowsFileWithoutDeleteSharing };

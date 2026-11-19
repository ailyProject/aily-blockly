'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Only used to migrate legacy PID-only contenders. New contenders use an OS
// handle, so PID reuse and wall-clock changes do not decide their ownership.
function processStartedAt(pid, options = {}) {
  const platform = options.platform || process.platform;
  const exec = options.execFileSync || execFileSync;
  const settings = { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] };
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    let value;
    if (platform === 'win32') {
      value = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')`], settings);
    } else if (platform === 'darwin') {
      value = exec('ps', ['-p', String(pid), '-o', 'lstart='], { ...settings, env: { ...process.env, LC_ALL: 'C' } });
    } else if (platform === 'linux') {
      // Linux exposes a boot-relative start time; convert only for old records.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
      const boot = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
      const ticks = Number(exec('getconf', ['CLK_TCK'], settings));
      return boot && ticks > 0 ? Number(boot[1]) * 1000 + Number(stat[19]) * 1000 / ticks : null;
    }
    const timestamp = Date.parse(String(value || '').trim());
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch { return null; } // Unknown identity never authorizes takeover.
}

module.exports = { processStartedAt };

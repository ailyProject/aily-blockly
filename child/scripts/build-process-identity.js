'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Observation only. No PID/time-based identity ever grants lock cleanup.
function processIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
        if (process.platform === 'linux') {
            const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
            return /^\d+$/.test(fields[19]) ? `linux:${fields[19]}` : null;
        }
        if (process.platform === 'win32' && process.env.SystemRoot) {
            const value = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
                { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            return /^\d+$/.test(value) ? `win32:${value}` : null;
        }
    } catch { /* Missing/denied identity remains unconfirmed. */ }
    return null;
}
module.exports = { processIdentity };

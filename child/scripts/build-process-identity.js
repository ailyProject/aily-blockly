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
// macOS ps exposes start time to the second. Use it only for observing a
// build whose native workspace token also matches. It must not participate in
// lock recovery, admission, or process termination.
function observeBuildProcessIdentity(pid) {
    if (process.platform !== 'darwin') return processIdentity(pid);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
        const value = execFileSync('/bin/ps', ['-o', 'pid=,lstart=', '-p', String(pid)], {
            encoding: 'utf8', timeout: 1000, maxBuffer: 1024,
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const match = /^(\d+)\s+([a-z]{3}\s+[a-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/i.exec(value);
        if (match && Number(match[1]) === pid) return `darwin:${match[2].replace(/\s+/g, ' ')}`;
    } catch { /* A missing identity cannot confirm the running writer. */ }
    return null;
}

module.exports = { processIdentity, observeBuildProcessIdentity };

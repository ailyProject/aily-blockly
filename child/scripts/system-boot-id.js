'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';
let cached;

// An opaque kernel boot identity, never Date.now() - uptime: clock corrections,
// sleep and restarting Aily must not look like the end of every compiler process.
// Windows SystemBootEnvironmentInformation (90) starts with a GUID on both ABIs.
const WINDOWS_BOOT_ID = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class AilyBootIdentity {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr p, int n, out int r);
  public static string Read() {
    IntPtr p = Marshal.AllocHGlobal(32);
    try { int r; if (NtQuerySystemInformation(90, p, 32, out r) != 0 || r < 16) return "";
      return ((Guid)Marshal.PtrToStructure(p, typeof(Guid))).ToString();
    } finally { Marshal.FreeHGlobal(p); }
  }
}'
[AilyBootIdentity]::Read()
`;

function getSystemBootId() {
    if (cached !== undefined) return cached;
    cached = null; // Unsupported/denied queries retain protection, including on retries.
    try {
        const options = { encoding: 'utf8', timeout: 3000, maxBuffer: 16384, windowsHide: true };
        let value;
        if (process.platform === 'linux') value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
        else if (process.platform === 'darwin') value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options);
        else if (process.platform === 'win32' && process.env.SystemRoot) {
            value = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOT_ID], options);
        }
        value = value?.trim();
        if (UUID.test(value || '') && value !== EMPTY_UUID) {
            cached = `${process.platform}:${value.toLowerCase()}`;
        }
    } catch { /* No PID/time-based fallback can prove that orphan descendants stopped. */ }
    return cached;
}

function isSystemBootId(value) {
    if (typeof value !== 'string' || !/^(darwin|linux|win32):/.test(value)) return false;
    const uuid = value.slice(value.indexOf(':') + 1);
    return UUID.test(uuid) && uuid !== EMPTY_UUID;
}

module.exports = { getSystemBootId, isSystemBootId };

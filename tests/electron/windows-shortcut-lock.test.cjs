const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('installer shortcut handle blocks legacy DeleteFile until released', {
  skip: process.platform !== 'win32',
}, () => {
  const include = process.env.AILY_INSTALLER_INCLUDE
    || path.resolve(__dirname, '../../build/installer-common.nsh');
  const source = fs.readFileSync(include, 'utf8');
  const call = source.match(/CreateFileW\(w "[^"]+", i (0x[0-9a-f]+|\d+), i (\d+),/i);
  assert.ok(call, 'Cannot locate production shortcut handle parameters');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-shortcut-sharing-'));
  try {
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'fixtures/windows-shortcut-lock.ps1'),
      '-Directory', directory, '-DesiredAccess', String(Number(call[1])), '-ShareMode', call[2]], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    const proof = JSON.parse(result.stdout.trim());
    assert.equal(proof.queryOnlyDeleteSucceeded, true);
    assert.equal(proof.productionDeleteBlocked, true);
    assert.equal(proof.productionDeleteError, 32);
    assert.equal(proof.deleteAfterCloseSucceeded, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

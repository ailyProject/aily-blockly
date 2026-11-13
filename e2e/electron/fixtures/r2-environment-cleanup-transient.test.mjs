import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import test from 'node:test'
import { environmentProcessStopScript } from './r2-environment-cleanup.mjs'

test('a transient missing executable skips gone/reused identities, refuses live unknown and still stops a verified child',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    const ended = once(child, 'exit'), exec = promisify(execFile)
    const ps = script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })
    try {
      const { stdout } = await ps("Get-CimInstance Win32_Process -Filter 'ProcessId = " + child.pid + "' | Select-Object ProcessId,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress")
      const captured = JSON.parse(stdout)
      const missing = { ...captured, ExecutablePath: null }
      // A reused PID is simulated only through a different expected creation;
      // the live process is our one child and must remain alive after no-op.
      await ps(environmentProcessStopScript({ ...missing, CreationDate: '2000-01-01T00:00:00.0000000Z' }))
      assert.equal(child.exitCode, null)
      await assert.rejects(() => ps(environmentProcessStopScript(missing)), /termination refused/)
      assert.equal(child.exitCode, null)
      await ps(environmentProcessStopScript(captured))
      await ended
      // The original child has now exited. A missing path cannot abort cleanup
      // because there is no longer an original process to terminate.
      await ps(environmentProcessStopScript(missing))
      assert.notEqual(child.exitCode, null)
    } finally { if (child.exitCode === null) { child.kill(); await ended } }
  })

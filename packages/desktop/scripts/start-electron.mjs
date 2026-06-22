import { spawn } from 'node:child_process'

import { resetDesktopStartupLog, writeDesktopStartupLog } from './log.mjs'
import { resolveElectronBinaryPath } from './electron-runtime.mjs'

resetDesktopStartupLog()
writeDesktopStartupLog('[start-electron] resolve-binary-start')
const electronBinaryPath = await resolveElectronBinaryPath()
writeDesktopStartupLog(`[start-electron] resolve-binary-finish ${electronBinaryPath}`)

const child = spawn(electronBinaryPath, ['.'], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: process.env
})
writeDesktopStartupLog('[start-electron] spawn-finish')

let shuttingDown = false

/**
 * 统一关闭 Electron 子进程。
 * @param {number} code
 */
const shutdown = code => {
	if (shuttingDown) return
	shuttingDown = true
	writeDesktopStartupLog(`[start-electron] shutdown ${String(code)}`)
	if (!child.killed) {
		child.kill('SIGTERM')
	}
	setTimeout(() => {
		process.exit(code)
	}, 1_000)
}

process.on('SIGINT', () => {
	shutdown(0)
})

process.on('SIGTERM', () => {
	shutdown(0)
})

child.once('exit', code => {
	writeDesktopStartupLog(`[start-electron] child-exit ${String(code ?? 0)}`)
	process.exit(code ?? 0)
})

child.once('error', error => {
	writeDesktopStartupLog(
		`[start-electron] child-error ${error instanceof Error ? error.stack || error.message : String(error)}`
	)
	console.error(error)
	process.exit(1)
})

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { clearDesktopPid, resetDesktopStartupLog, writeDesktopPid, writeDesktopStartupLog } from './log.mjs'
import { resolveElectronBinaryPath } from './electron-runtime.mjs'

const mainEntryPath = path.resolve(process.cwd(), 'dist/main/index.cjs')
const preloadEntryPath = path.resolve(process.cwd(), 'dist/preload/index.cjs')

/**
 * 等待 desktop 主进程与 preload 产物就绪。
 */
const waitForDesktopBuildOutput = async () => {
	writeDesktopStartupLog('[start-electron] wait-build-output-start')

	for (;;) {
		if (fs.existsSync(mainEntryPath) && fs.existsSync(preloadEntryPath)) {
			writeDesktopStartupLog('[start-electron] wait-build-output-finish')
			return
		}

		await new Promise(resolve => setTimeout(resolve, 250))
	}
}

if (process.env['AILY_DESKTOP_PRESERVE_LOG'] !== '1') {
	resetDesktopStartupLog()
}
await waitForDesktopBuildOutput()
writeDesktopStartupLog('[start-electron] resolve-binary-start')
const electronBinaryPath = await resolveElectronBinaryPath()
writeDesktopStartupLog(`[start-electron] resolve-binary-finish ${electronBinaryPath}`)

const child = spawn(electronBinaryPath, ['.'], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: process.env
})
writeDesktopStartupLog('[start-electron] spawn-finish')
writeDesktopPid(child.pid)

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
		clearDesktopPid()
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
	clearDesktopPid()
	process.exit(code ?? 0)
})

child.once('error', error => {
	writeDesktopStartupLog(
		`[start-electron] child-error ${error instanceof Error ? error.stack || error.message : String(error)}`
	)
	console.error(error)
	process.exit(1)
})

import { spawn } from 'node:child_process'
import path from 'node:path'

import Watchpack from 'watchpack'

import { resetDesktopStartupLog, writeDesktopStartupLog } from './log.mjs'
import { resolveElectronBinaryPath } from './electron-runtime.mjs'

const cwd = process.cwd()
const watcher = new Watchpack({})
const mainEntryPath = path.resolve(cwd, 'dist/main/index.cjs')
const preloadEntryPath = path.resolve(cwd, 'dist/preload/index.cjs')

let electronProcess = null
let restarting = false

/**
 * 启动 Electron 主进程。
 */
const startElectronProcess = async () => {
	writeDesktopStartupLog('[dev-runner] electron-start-start')
	const electronBinaryPath = await resolveElectronBinaryPath()
	writeDesktopStartupLog(`[dev-runner] electron-binary ${electronBinaryPath}`)

	electronProcess = spawn(electronBinaryPath, ['.'], {
		cwd,
		stdio: 'inherit',
		env: {
			...process.env,
			AILY_UI_DEV_SERVER_URL: process.env['AILY_UI_DEV_SERVER_URL'] || 'http://127.0.0.1:4200'
		}
	})

	electronProcess.once('exit', code => {
		writeDesktopStartupLog(`[dev-runner] electron-exit ${String(code ?? 0)}`)
		electronProcess = null
	})
	writeDesktopStartupLog('[dev-runner] electron-start-finish')
}

/**
 * 停止当前 Electron 进程。
 */
const stopElectronProcess = async () => {
	if (!electronProcess) return

	writeDesktopStartupLog('[dev-runner] electron-stop-start')
	const currentProcess = electronProcess
	electronProcess = null
	currentProcess.removeAllListeners()
	currentProcess.kill('SIGTERM')

	await new Promise(resolve => {
		currentProcess.once?.('exit', () => resolve())
		setTimeout(resolve, 2_000)
	})
	writeDesktopStartupLog('[dev-runner] electron-stop-finish')
}

/**
 * 重启 Electron。
 */
const restartElectronProcess = async () => {
	if (restarting) return
	restarting = true
	writeDesktopStartupLog('[dev-runner] electron-restart-start')
	try {
		await stopElectronProcess()
		await startElectronProcess()
	} finally {
		writeDesktopStartupLog('[dev-runner] electron-restart-finish')
		restarting = false
	}
}

/**
 * 统一关闭 runner。
 * @param {number} code
 */
const shutdown = async code => {
	writeDesktopStartupLog(`[dev-runner] shutdown ${String(code)}`)
	await stopElectronProcess()
	process.exit(code)
}

process.on('SIGINT', () => {
	void shutdown(0)
})
process.on('SIGTERM', () => {
	void shutdown(0)
})

resetDesktopStartupLog()
writeDesktopStartupLog('[dev-runner] boot')

watcher.watch({
	files: [mainEntryPath, preloadEntryPath]
})

watcher.on('change', filePath => {
	writeDesktopStartupLog(`[dev-runner] change ${String(filePath)}`)
	void restartElectronProcess()
})

await startElectronProcess()

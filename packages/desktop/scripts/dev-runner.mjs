import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

import Watchpack from 'watchpack'

import { clearDesktopPid, readDesktopPid, resetDesktopStartupLog, writeDesktopPid, writeDesktopStartupLog } from './log.mjs'
import { resolveElectronBinaryPath } from './electron-runtime.mjs'

const cwd = process.cwd()
const watcher = new Watchpack({})
const mainEntryPath = path.resolve(cwd, 'dist/main/index.cjs')
const preloadEntryPath = path.resolve(cwd, 'dist/preload/index.cjs')

let electronProcess = null
let restarting = false
let lastBuildSignature = ''
let startupGraceActive = true

/**
 * 读取当前 desktop 构建产物签名。
 * @returns {string}
 */
const readDesktopBuildSignature = () => {
	if (!fs.existsSync(mainEntryPath) || !fs.existsSync(preloadEntryPath)) return ''

	const mainStat = fs.statSync(mainEntryPath)
	const preloadStat = fs.statSync(preloadEntryPath)
	return `${mainStat.size}:${mainStat.mtimeMs}|${preloadStat.size}:${preloadStat.mtimeMs}`
}

/**
 * 等待 desktop 主进程与 preload 构建产物稳定落盘。
 */
const waitForDesktopBuildOutput = async () => {
	writeDesktopStartupLog('[dev-runner] wait-build-output-start')

	let lastSeenSignature = ''
	let stableSince = 0

	for (;;) {
		const signature = readDesktopBuildSignature()
		if (signature) {
			if (signature !== lastSeenSignature) {
				lastSeenSignature = signature
				stableSince = Date.now()
			} else if (Date.now() - stableSince >= 1_000) {
				lastBuildSignature = signature
				writeDesktopStartupLog(`[dev-runner] wait-build-output-finish ${signature}`)
				return
			}
		}

		await new Promise(resolve => setTimeout(resolve, 250))
	}
}

/**
 * 尝试清理上次残留的 desktop Electron 进程。
 */
const cleanupStaleElectronProcess = () => {
	const stalePid = readDesktopPid()
	if (!stalePid) return

	try {
		process.kill(stalePid, 'SIGTERM')
		writeDesktopStartupLog(`[dev-runner] cleanup-stale-sigterm ${stalePid}`)
	} catch {
		// stale pid may already be gone
	}

	clearDesktopPid()

	if (process.platform !== 'win32') {
		try {
			spawn('pkill', ['-f', 'Electron dist/main/index.cjs'], { stdio: 'ignore' })
			spawn('pkill', ['-f', 'Electron \\.'], { stdio: 'ignore' })
			writeDesktopStartupLog('[dev-runner] cleanup-stale-pkill')
		} catch {
			// ignore best-effort cleanup failures
		}
	}
}

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
	writeDesktopPid(electronProcess.pid)

	electronProcess.once('exit', code => {
		writeDesktopStartupLog(`[dev-runner] electron-exit ${String(code ?? 0)}`)
		clearDesktopPid()
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
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			resolve()
		}

		currentProcess.once?.('exit', finish)
		setTimeout(() => {
			if (!currentProcess.killed) {
				try {
					currentProcess.kill('SIGKILL')
					writeDesktopStartupLog('[dev-runner] electron-stop-sigkill')
				} catch {
					// process may have already exited
				}
			}
			finish()
		}, 2_000)
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
cleanupStaleElectronProcess()

watcher.watch({
	files: [mainEntryPath, preloadEntryPath]
})

watcher.on('change', filePath => {
	const nextSignature = readDesktopBuildSignature()
	writeDesktopStartupLog(`[dev-runner] change ${String(filePath)} ${nextSignature}`)

	if (startupGraceActive) {
		writeDesktopStartupLog('[dev-runner] change-ignored-startup-grace')
		return
	}

	if (!nextSignature || nextSignature === lastBuildSignature) {
		writeDesktopStartupLog('[dev-runner] change-ignored-same-signature')
		return
	}

	lastBuildSignature = nextSignature
	void restartElectronProcess()
})

await waitForDesktopBuildOutput()
await startElectronProcess()
setTimeout(() => {
	startupGraceActive = false
	writeDesktopStartupLog('[dev-runner] startup-grace-finished')
}, 2_000)

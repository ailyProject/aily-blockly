import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { clearDesktopPid, readDesktopPid, resetDesktopStartupLog, writeDesktopStartupLog } from './log.mjs'

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const cwd = process.cwd()
const devBootStartedAt = Date.now()
const mainEntryPath = path.resolve(cwd, 'dist/main/index.cjs')
const preloadEntryPath = path.resolve(cwd, 'dist/preload/index.cjs')

let mainWatchProcess = null
let electronWatchProcess = null
let shuttingDown = false

/**
 * 启动子脚本。
 * @param {string[]} args
 */
const startChild = args =>
	spawn(pnpmCommand, args, {
		cwd,
		stdio: 'inherit',
		env: process.env
	})

/**
 * 等待本轮 dev 启动后的 desktop 构建产物稳定落盘。
 */
const waitForFreshDesktopBuildOutput = async () => {
	writeDesktopStartupLog('[desktop-dev] wait-build-output-start')

	for (;;) {
		const hasMain = fs.existsSync(mainEntryPath)
		const hasPreload = fs.existsSync(preloadEntryPath)

		if (hasMain && hasPreload) {
			const mainStat = fs.statSync(mainEntryPath)
			const preloadStat = fs.statSync(preloadEntryPath)

			if (mainStat.mtimeMs >= devBootStartedAt && preloadStat.mtimeMs >= devBootStartedAt) {
				writeDesktopStartupLog('[desktop-dev] wait-build-output-finish')
				return
			}
		}

		await new Promise(resolve => setTimeout(resolve, 250))
	}
}

/**
 * 启动前清理上次残留的 Electron 进程。
 */
const cleanupStaleElectronProcess = () => {
	const stalePid = readDesktopPid()
	if (stalePid) {
		try {
			process.kill(stalePid, 'SIGTERM')
			writeDesktopStartupLog(`[desktop-dev] cleanup-stale-sigterm ${stalePid}`)
		} catch {
			// stale pid may already be gone
		}
	}

	clearDesktopPid()

	if (process.platform !== 'win32') {
		try {
			spawn('pkill', ['-f', 'Electron dist/main/index.cjs'], { stdio: 'ignore' })
			writeDesktopStartupLog('[desktop-dev] cleanup-stale-pkill')
		} catch {
			// ignore best-effort cleanup failures
		}
	}
}

/**
 * 统一关闭所有开发子进程。
 * @param {number} code
 */
const shutdown = code => {
	if (shuttingDown) return
	shuttingDown = true
	writeDesktopStartupLog(`[desktop-dev] shutdown ${String(code)}`)

	for (const child of [electronWatchProcess, mainWatchProcess]) {
		if (child && !child.killed) {
			child.kill('SIGTERM')
		}
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

resetDesktopStartupLog()
writeDesktopStartupLog('[desktop-dev] boot')
cleanupStaleElectronProcess()

mainWatchProcess = startChild(['run', 'main:dev'])
await waitForFreshDesktopBuildOutput()
electronWatchProcess = startChild(['run', 'watch'])

for (const child of [mainWatchProcess, electronWatchProcess]) {
	child.once('exit', code => {
		if (shuttingDown) return

		writeDesktopStartupLog(`[desktop-dev] child-exit ${String(code ?? 0)}`)
		shutdown(code ?? 0)
	})
	child.once('error', error => {
		writeDesktopStartupLog(`[desktop-dev] child-error ${error instanceof Error ? error.message : String(error)}`)
		shutdown(1)
	})
}

await new Promise(() => {})

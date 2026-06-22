import { spawn } from 'node:child_process'

import { resetDesktopStartupLog, writeDesktopStartupLog } from './log.mjs'

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const cwd = process.cwd()

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

mainWatchProcess = startChild(['run', 'main:dev'])
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

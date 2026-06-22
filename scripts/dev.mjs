import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const cwd = process.cwd()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const uiDevServerUrl = new URL(process.env['AILY_UI_DEV_SERVER_URL'] || 'http://127.0.0.1:4200')
const uiDevServerTimeoutMs = 180_000

let uiProcess = null
let desktopProcess = null
let shuttingDown = false

/**
 * 启动一个长期运行的 dev 子进程，并沿用当前终端输出。
 * @param {string} label
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} extraEnv
 */
const startPersistentProcess = (label, args, extraEnv = {}) => {
	console.log(`[root-dev] start ${label}: ${args.join(' ')}`)

	const child = spawn(pnpmCommand, args, {
		cwd,
		stdio: 'inherit',
		env: {
			...process.env,
			...extraEnv
		}
	})

	child.once('error', error => {
		console.error(`[root-dev] ${label} error:`, error)
		void shutdown(1)
	})

	child.once('exit', code => {
		if (shuttingDown) return

		console.error(`[root-dev] ${label} exited with code ${String(code ?? 0)}`)
		void shutdown(code ?? 0)
	})

	return child
}

/**
 * 休眠指定时长。
 * @param {number} ms
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 等待子进程退出；如果在限定时间内仍未退出，则直接继续收尾。
 * @param {import('node:child_process').ChildProcess | null} child
 * @param {number} timeoutMs
 */
const waitForProcessExit = async (child, timeoutMs = 5_000) => {
	if (!child || child.exitCode != null) return

	await new Promise(resolve => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			resolve()
		}

		child.once('exit', finish)
		setTimeout(finish, timeoutMs)
	})
}

/**
 * 在启动 UI 前确认目标地址端口未被其他进程占用，避免 Electron 误连旧页面。
 * @param {URL} targetUrl
 */
const assertDevServerPortAvailable = async targetUrl => {
	const host = targetUrl.hostname
	const port = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'))

	await new Promise((resolve, reject) => {
		const server = createServer()

		server.once('error', error => {
			server.close()
			reject(error)
		})

		server.once('listening', () => {
			server.close(closeError => {
				if (closeError) {
					reject(closeError)
					return
				}

				resolve()
			})
		})

		server.listen(port, host)
	})
}

/**
 * 等待目标 URL 变为可访问状态。
 * @param {URL} targetUrl
 * @param {number} timeoutMs
 * @param {string} label
 */
const waitForHttpReady = async (targetUrl, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs

	console.log(`[root-dev] wait ${label}: ${targetUrl.href}`)

	while (Date.now() < deadline) {
		let timer = null

		try {
			const controller = new AbortController()
			timer = setTimeout(() => controller.abort(), 1_000)
			const response = await fetch(targetUrl, { signal: controller.signal })

			if (response.ok) {
				clearTimeout(timer)
				console.log(`[root-dev] ready ${label}: ${targetUrl.href}`)
				return
			}
		} catch {
			// keep polling until timeout or child exit
		} finally {
			if (timer) {
				clearTimeout(timer)
			}
		}

		if (uiProcess?.exitCode != null) {
			throw new Error(`UI dev process exited before ${targetUrl.href} became ready.`)
		}

		await sleep(500)
	}

	throw new Error(`Timed out waiting for ${targetUrl.href} to become ready.`)
}

/**
 * 统一关闭 root dev 管理的子进程。
 * @param {number} code
 */
const shutdown = async code => {
	if (shuttingDown) return
	shuttingDown = true

	console.log(`[root-dev] shutdown ${String(code)}`)

	for (const child of [desktopProcess, uiProcess]) {
		if (child && !child.killed) {
			child.kill('SIGTERM')
		}
	}

	await Promise.all([waitForProcessExit(desktopProcess), waitForProcessExit(uiProcess)])
	process.exit(code)
}

process.on('SIGINT', () => {
	void shutdown(0)
})

process.on('SIGTERM', () => {
	void shutdown(0)
})

try {
	await assertDevServerPortAvailable(uiDevServerUrl)
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	console.error(
		`[root-dev] UI dev server port is unavailable at ${uiDevServerUrl.href}. ` +
			`Stop the existing listener before running root pnpm dev.\n${message}`
	)
	process.exit(1)
}

uiProcess = startPersistentProcess('ui', ['exec', 'turbo', 'run', 'dev', '--filter=ui'], {
	CI: '1'
})

try {
	await waitForHttpReady(uiDevServerUrl, uiDevServerTimeoutMs, 'ui')
} catch (error) {
	console.error('[root-dev] UI failed to become ready:', error)
	await shutdown(1)
}

desktopProcess = startPersistentProcess('desktop', ['exec', 'turbo', 'run', 'dev', '--filter=desktop'], {
	AILY_UI_DEV_SERVER_URL: uiDevServerUrl.href
})

await new Promise(() => {})

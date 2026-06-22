import { spawn } from 'node:child_process'

import { logChildTool, logChildToolError } from './shared'

import type { ChildToolHostInfo, ChildToolRuntimeConfig } from '../types'
import type { ChildToolSession } from './shared'

/**
 * 启动子工具宿主进程，并等待 ready 消息。
 * @param config - 子工具运行时配置
 * @param session - 当前会话槽
 */
export const startChildToolProcess = (config: ChildToolRuntimeConfig, session: ChildToolSession) =>
	new Promise<ChildToolHostInfo>((resolve, reject) => {
		const child = spawn(process.execPath, [config.scriptPath, 'serve', '--host', '127.0.0.1', '--port', '0'], {
			cwd: config.projectPath,
			env: {
				...process.env,
				AILY_CHILD_TOOL: '1',
				AILY_CHILD_TOOL_ID: config.id
			},
			stdio: ['ignore', 'pipe', 'pipe']
		})

		session.process = child
		session.stdoutBuffer = ''
		session.stderrBuffer = ''

		const timeout = setTimeout(() => {
			reject(new Error(`${config.id} server did not report ready`))
		}, config.startupTimeoutMs ?? 8000)

		const cleanUp = () => {
			clearTimeout(timeout)
			child.stdout?.removeAllListeners()
			child.stderr?.removeAllListeners()
			child.removeAllListeners()
		}

		child.stdout?.on('data', chunk => {
			session.stdoutBuffer += chunk.toString()
			const lines = session.stdoutBuffer.split(/\r?\n/)
			session.stdoutBuffer = lines.pop() || ''

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					const message = JSON.parse(trimmed) as { event?: string; data?: ChildToolHostInfo & { message?: string } }
					if (message.event === 'ready' && message.data?.url) {
						session.hostInfo = { ...message.data, pid: child.pid ?? undefined }
						logChildTool(config.id, 'ready', session.hostInfo)
						cleanUp()
						resolve(session.hostInfo)
						return
					}

					if (message.event === 'fatal') {
						const reason = message.data?.message || `${config.id} server fatal error`
						logChildToolError(config.id, 'fatal', reason)
						cleanUp()
						reject(new Error(reason))
						return
					}
				} catch {
					logChildTool(config.id, 'stdout', trimmed)
				}
			}
		})

		child.stderr?.on('data', chunk => {
			session.stderrBuffer += chunk.toString()
			logChildToolError(config.id, 'stderr', chunk.toString().trim())
		})

		child.on('error', error => {
			cleanUp()
			logChildToolError(config.id, 'process error', error.message)
			reject(error)
		})

		child.on('exit', code => {
			session.process = null
			session.hostInfo = null
			const reason = `${config.id} server closed with code ${code ?? 'unknown'}`
			logChildToolError(config.id, 'process closed', reason)
			cleanUp()
			reject(new Error(reason))
		})
	})

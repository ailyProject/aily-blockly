import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 尝试终止终端会话对应的整个进程树。
 * @param pid - PTY 根进程 PID
 */
export const killTerminalProcessTree = async (pid: number) => {
	if (!Number.isFinite(pid) || pid <= 0) return

	if (process.platform === 'win32') {
		await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined)
		return
	}

	try {
		process.kill(pid, 'SIGTERM')
	} catch {
		return
	}
}

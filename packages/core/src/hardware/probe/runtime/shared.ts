import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 解析 probe-rs 二进制路径。
 */
export const resolveHardwareProbeRsPath = () => {
	const childPath = process.env['AILY_CHILD_PATH'] || path.join(process.cwd(), 'child')
	const ext = process.platform === 'win32' ? '.exe' : ''
	return path.join(childPath, 'probe-rs', `probe-rs${ext}`)
}

/**
 * 检查 probe-rs 二进制是否可用。
 */
export const hasHardwareProbeRsBinary = () => existsSync(resolveHardwareProbeRsPath())

export const runHardwareProbeRs = (args: Array<string>) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execFile(resolveHardwareProbeRsPath(), args, { encoding: 'utf-8', timeout: 120_000 }, (error, stdout, stderr) => {
			if (error) {
				reject({ message: stderr.trim() || error.message, stdout: stdout.trim() })
				return
			}

			resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
		})
	})

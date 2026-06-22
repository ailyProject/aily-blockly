import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 项目前置能力的标准结果。
 */
export interface DesktopProjectOpenFocusResult {
	/**
	 * 本次前置动作是否成功。
	 */
	success: boolean

	/**
	 * 失败时的错误文本。
	 */
	error?: string
}

/**
 * 判断 pid 是否是有效的正整数。
 * @param pid - 待校验的进程 ID
 */
export const isDesktopProjectOpenFocusPid = (pid: number) => Number.isInteger(pid) && pid > 0

/**
 * 执行一个短超时的宿主命令。
 * @param command - 可执行文件名
 * @param args - 命令参数
 */
export const execDesktopProjectOpenFocusCommand = async (command: string, args: Array<string>) =>
	execFileAsync(command, args, {
		encoding: 'utf-8',
		timeout: 10_000,
		windowsHide: true
	})

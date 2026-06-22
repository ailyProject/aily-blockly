import { execDesktopProjectOpenFocusCommand } from './shared'

import type { DesktopProjectOpenFocusResult } from './shared'

const parseLinuxWindowId = (stdout: string, pid: number) => {
	for (const line of stdout.split('\n')) {
		const match = line.trim().match(/^(\S+)\s+\S+\s+(\d+)\s+/)
		if (!match) continue
		if (Number(match[2]) !== pid) continue
		return match[1]
	}

	return ''
}

/**
 * 解析 xdotool 返回的首个窗口 ID。
 * @param stdout - xdotool search 原始输出
 */
const parseLinuxXdotoolWindowId = (stdout: string) =>
	stdout
		.split('\n')
		.map(line => line.trim())
		.find(Boolean) || ''

/**
 * 通过 xdotool 尝试前置指定 pid 的窗口。
 * @param pid - 目标进程 ID
 */
const focusDesktopProjectOpenProcessWithXdotool = async (pid: number): Promise<DesktopProjectOpenFocusResult> => {
	try {
		const searchedWindows = await execDesktopProjectOpenFocusCommand('xdotool', ['search', '--pid', String(pid)])
		const windowId = parseLinuxXdotoolWindowId(searchedWindows.stdout)
		if (!windowId) {
			return {
				success: false,
				error: 'No xdotool window was found for the target process'
			}
		}

		await execDesktopProjectOpenFocusCommand('xdotool', ['windowactivate', windowId])
		return { success: true }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}

/**
 * 在 Linux 上尝试前置指定 pid 的窗口。
 * @param pid - 目标进程 ID
 */
export const focusDesktopProjectOpenProcessOnLinux = async (pid: number): Promise<DesktopProjectOpenFocusResult> => {
	const wmctrlResult = await (async () => {
		const listedWindows = await execDesktopProjectOpenFocusCommand('wmctrl', ['-lp'])
		const windowId = parseLinuxWindowId(listedWindows.stdout, pid)
		if (!windowId) {
			return {
				success: false,
				error: 'No desktop window was found for the target process'
			}
		}

		await execDesktopProjectOpenFocusCommand('wmctrl', ['-ia', windowId])
		return { success: true }
	})().catch(error => ({
		success: false,
		error: error instanceof Error ? error.message : String(error)
	}))

	if (wmctrlResult.success) {
		return wmctrlResult
	}

	const xdotoolResult = await focusDesktopProjectOpenProcessWithXdotool(pid)
	if (xdotoolResult.success) {
		return xdotoolResult
	}

	return {
		success: false,
		error: [wmctrlResult.error, xdotoolResult.error].filter(Boolean).join(' | ') || 'Failed to focus the target process'
	}
}

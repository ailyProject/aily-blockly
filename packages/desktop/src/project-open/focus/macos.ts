import { execDesktopProjectOpenFocusCommand } from './shared'

import type { DesktopProjectOpenFocusResult } from './shared'

/**
 * 在 macOS 上尝试前置指定 pid 的窗口。
 * @param pid - 目标进程 ID
 */
export const focusDesktopProjectOpenProcessOnMacos = async (pid: number): Promise<DesktopProjectOpenFocusResult> => {
	const script = [
		'tell application "System Events"',
		`set frontmost of first process whose unix id is ${pid} to true`,
		'end tell'
	].join('\n')

	try {
		await execDesktopProjectOpenFocusCommand('/usr/bin/osascript', ['-e', script])
		return { success: true }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}

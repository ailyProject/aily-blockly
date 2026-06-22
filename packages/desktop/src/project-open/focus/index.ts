import { focusDesktopProjectOpenProcessOnLinux } from './linux'
import { focusDesktopProjectOpenProcessOnMacos } from './macos'
import { focusDesktopProjectOpenCurrentWindow } from './self'
import { isDesktopProjectOpenFocusPid } from './shared'
import { focusDesktopProjectOpenProcessOnWindows } from './windows'

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopProjectOpenFocusResult } from './shared'

/**
 * 尝试把指定 pid 对应的桌面会话前置到最前。
 * @param event - 当前 IPC 事件
 * @param pid - 目标进程 ID
 */
export const focusDesktopProjectOpenProcess = async (
	event: IpcMainInvokeEvent,
	pid: number
): Promise<DesktopProjectOpenFocusResult> => {
	if (!isDesktopProjectOpenFocusPid(pid)) {
		return {
			success: false,
			error: 'Invalid process id'
		}
	}

	if (pid === process.pid) {
		return focusDesktopProjectOpenCurrentWindow(event)
	}

	if (process.platform === 'darwin') {
		return focusDesktopProjectOpenProcessOnMacos(pid)
	}

	if (process.platform === 'win32') {
		return focusDesktopProjectOpenProcessOnWindows(pid)
	}

	return focusDesktopProjectOpenProcessOnLinux(pid)
}

export type { DesktopProjectOpenFocusResult }

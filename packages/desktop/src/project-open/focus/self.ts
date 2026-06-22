import { BrowserWindow } from 'electron'

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopProjectOpenFocusResult } from './shared'

/**
 * 尝试把当前 Electron 窗口前置到最前。
 * @param event - 当前 IPC 事件
 */
export const focusDesktopProjectOpenCurrentWindow = async (
	event: IpcMainInvokeEvent
): Promise<DesktopProjectOpenFocusResult> => {
	const senderWindow = BrowserWindow.fromWebContents(event.sender)
	if (!senderWindow) {
		return {
			success: false,
			error: 'Desktop window is not available'
		}
	}

	if (senderWindow.isMinimized()) {
		senderWindow.restore()
	}

	senderWindow.show()
	senderWindow.focus()
	return { success: true }
}

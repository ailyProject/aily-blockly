import { BrowserWindow } from 'electron'

import { p } from '../../trpc'

import type { DesktopWindowStateResult } from '../types'

export default p.mutation(({ ctx }): DesktopWindowStateResult => {
	const senderWindow = BrowserWindow.fromWebContents(ctx.event.sender)
	if (!senderWindow) {
		return {
			available: false,
			error: 'No sender window was found.',
			isMaximized: false,
			isFullScreen: false
		}
	}

	if (senderWindow.isMaximized()) {
		senderWindow.unmaximize()
	} else {
		senderWindow.maximize()
	}

	return {
		available: true,
		isMaximized: senderWindow.isMaximized(),
		isFullScreen: senderWindow.isFullScreen()
	}
})

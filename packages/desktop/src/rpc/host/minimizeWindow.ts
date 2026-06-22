import { BrowserWindow } from 'electron'

import { p } from '../../trpc'

import type { DesktopHostCapabilityResult } from '../types'

export default p.mutation(({ ctx }): DesktopHostCapabilityResult => {
	const senderWindow = BrowserWindow.fromWebContents(ctx.event.sender)
	if (!senderWindow) {
		return {
			available: false,
			error: 'No sender window was found.'
		}
	}

	senderWindow.minimize()
	return { available: true }
})

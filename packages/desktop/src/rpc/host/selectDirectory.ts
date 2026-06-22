import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'

import { p } from '../../trpc'

import type { OpenDialogOptions } from 'electron'

export default p
	.input(
		z.object({
			path: z.string().optional()
		})
	)
	.query(async ({ ctx, input }) => {
		const senderWindow = BrowserWindow.fromWebContents(ctx.event.sender)
		const options: OpenDialogOptions = {
			defaultPath: input.path || undefined,
			properties: ['openDirectory']
		}
		const result = senderWindow
			? await dialog.showOpenDialog(senderWindow, options)
			: await dialog.showOpenDialog(options)

		return {
			path: result.canceled ? input.path || '' : (result.filePaths[0] ?? input.path ?? '')
		}
	})

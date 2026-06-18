import { z } from 'zod'

import { needHardwareFirmwareUpdate } from '../../hardware'
import { p } from '../trpc'

export const needFirmwareUpdate = p
	.input(
		z.object({
			currentVersion: z.string().optional(),
			latestVersion: z.string()
		})
	)
	.query(({ input }) => needHardwareFirmwareUpdate(input.currentVersion, input.latestVersion))

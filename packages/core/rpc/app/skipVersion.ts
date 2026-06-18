import { z } from 'zod'

import { skipAppVersion } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const skipVersion = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			version: z.string()
		})
	)
	.query(({ input }) => skipAppVersion(input.config, input.version))

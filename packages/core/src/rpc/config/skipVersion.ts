import { z } from 'zod'

import { skipAppVersion } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			version: z.string()
		})
	)
	.query(({ input }) => skipAppVersion(normalizeAppConfigInput(input.config), input.version))

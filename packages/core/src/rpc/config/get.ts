import { z } from 'zod'

import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'
import { resolveConfigSummary } from './summary'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			fallbackLanguage: z.string().optional(),
			userHome: z.string().optional()
		})
	)
	.query(({ input }) => resolveConfigSummary(normalizeAppConfigInput(input.config), input))

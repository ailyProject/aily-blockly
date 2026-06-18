import { z } from 'zod'

import { setThemeMode } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			themeMode: z.enum(['dark', 'light'])
		})
	)
	.query(({ input }) => setThemeMode(normalizeAppConfigInput(input.config), input.themeMode))

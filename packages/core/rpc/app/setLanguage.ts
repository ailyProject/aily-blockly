import { z } from 'zod'

import { setSelectedLanguage } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const setLanguage = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			selectedLanguage: z.string()
		})
	)
	.query(({ input }) => setSelectedLanguage(normalizeAppConfigInput(input.config), input.selectedLanguage))

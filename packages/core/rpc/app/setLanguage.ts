import { z } from 'zod'

import { setSelectedLanguage } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const setLanguage = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			selectedLanguage: z.string()
		})
	)
	.query(({ input }) => setSelectedLanguage(input.config, input.selectedLanguage))

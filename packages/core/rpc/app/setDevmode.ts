import { z } from 'zod'

import { setDevmodeConfig } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const setDevmode = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			devmode: z.object({
				enabled: z.boolean().optional(),
				autoSave: z.boolean().optional()
			})
		})
	)
	.query(({ input }) => setDevmodeConfig(input.config, input.devmode))

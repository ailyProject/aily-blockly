import { z } from 'zod'

import { setDevmodeAutoSave } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const setDevmodeAutoSave = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			autoSave: z.boolean()
		})
	)
	.query(({ input }) => setDevmodeAutoSave(input.config, input.autoSave))

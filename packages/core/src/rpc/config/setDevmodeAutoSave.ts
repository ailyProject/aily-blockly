import { z } from 'zod'

import { setDevmodeAutoSave as setDevmodeAutoSaveConfig } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			autoSave: z.boolean()
		})
	)
	.query(({ input }) => setDevmodeAutoSaveConfig(normalizeAppConfigInput(input.config), input.autoSave))

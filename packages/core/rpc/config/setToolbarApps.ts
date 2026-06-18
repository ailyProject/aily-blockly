import { z } from 'zod'

import { setToolbarAppIds } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const setToolbarApps = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			toolbarAppIds: z.array(z.string())
		})
	)
	.query(({ input }) => setToolbarAppIds(normalizeAppConfigInput(input.config), input.toolbarAppIds))

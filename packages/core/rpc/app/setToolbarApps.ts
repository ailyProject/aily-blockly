import { z } from 'zod'

import { setToolbarAppIds } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const setToolbarApps = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			toolbarAppIds: z.array(z.string())
		})
	)
	.query(({ input }) => setToolbarAppIds(input.config, input.toolbarAppIds))

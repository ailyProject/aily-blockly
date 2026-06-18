import { z } from 'zod'

import { addRecentlyProject as addRecentProjectEntry } from '../../project'
import { p } from '../trpc'
import { recentProjectSchema } from './schemas'

export default p
	.input(
		z.object({
			current: z.array(recentProjectSchema),
			entry: recentProjectSchema,
			maxSize: z.number().optional()
		})
	)
	.query(({ input }) => addRecentProjectEntry(input.current, input.entry, input.maxSize))

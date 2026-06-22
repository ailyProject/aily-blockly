import { z } from 'zod'

import { listCloudTemplates } from '../../cloud'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			authToken: z.string().optional(),
			page: z.number().int().min(1).optional(),
			pageSize: z.number().int().min(1).max(100).optional(),
			search: z.string().optional(),
			board: z.string().optional()
		})
	)
	.query(({ input }) => listCloudTemplates(input, input.authToken))

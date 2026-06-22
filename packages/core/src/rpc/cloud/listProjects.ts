import { z } from 'zod'

import { listCloudProjects } from '../../cloud'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			authToken: z.string().min(1),
			page: z.number().int().min(1).optional(),
			pageSize: z.number().int().min(1).max(100).optional(),
			search: z.string().optional(),
			id: z.string().optional(),
			board: z.string().optional()
		})
	)
	.query(({ input }) => listCloudProjects(input, input.authToken))

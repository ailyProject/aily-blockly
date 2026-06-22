import { z } from 'zod'

import { listPublicCloudProjects } from '../../cloud'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			page: z.number().int().min(1).optional(),
			pageSize: z.number().int().min(1).max(100).optional(),
			search: z.string().optional(),
			id: z.string().optional(),
			board: z.string().optional()
		})
	)
	.query(({ input }) => listPublicCloudProjects(input))

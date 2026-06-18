import { z } from 'zod'

import { addRecentlyProject } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

const recentProjectSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string()
})

export const addRecentProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			project: recentProjectSchema
		})
	)
	.query(({ input }) => addRecentlyProject(input.config, input.project))

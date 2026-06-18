import { z } from 'zod'

import { p } from '../trpc'
import { appSchema } from './schemas'

const recentProjectSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string()
})

export const setRecentProjects = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projects: z.array(recentProjectSchema)
		})
	)
	.query(({ input }) => ({
		...(input.config ?? {}),
		recentlyProjects: input.projects
	}))

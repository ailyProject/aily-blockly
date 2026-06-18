import { z } from 'zod'

import { p } from '../trpc'
import { appSchema } from './schemas'

const recentModelProjectSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string(),
	modelType: z.enum(['classification', 'detection', 'segmentation', 'pose']),
	updatedAt: z.string().optional()
})

export const setRecentModelProjects = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projects: z.array(recentModelProjectSchema)
		})
	)
	.query(({ input }) => ({
		...(input.config ?? {}),
		recentModelProjects: input.projects
	}))

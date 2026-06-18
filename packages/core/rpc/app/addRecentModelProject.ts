import { z } from 'zod'

import { addRecentModelProject } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

const recentModelProjectSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string(),
	modelType: z.enum(['classification', 'detection', 'segmentation', 'pose']),
	updatedAt: z.string().optional()
})

export const addRecentModelProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			project: recentModelProjectSchema
		})
	)
	.query(({ input }) => addRecentModelProject(input.config, input.project))

import { z } from 'zod'

import { removeRecentModelProject } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const removeRecentModelProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projectPath: z.string()
		})
	)
	.query(({ input }) => removeRecentModelProject(input.config, input.projectPath))

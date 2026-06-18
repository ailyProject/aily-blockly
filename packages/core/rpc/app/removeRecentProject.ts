import { z } from 'zod'

import { removeRecentlyProject } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const removeRecentProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projectPath: z.string()
		})
	)
	.query(({ input }) => removeRecentlyProject(input.config, input.projectPath))

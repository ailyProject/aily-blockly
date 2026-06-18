import { z } from 'zod'

import { getRecentProjects, removeRecentlyProject } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const removeRecentProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projectPath: z.string()
		})
	)
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return {
			...(config ?? {}),
			recentlyProjects: removeRecentlyProject(getRecentProjects(config), input.projectPath)
		}
	})

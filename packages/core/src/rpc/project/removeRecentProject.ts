import { z } from 'zod'

import { getRecentProjects as getProjectRecentProjects, removeRecentlyProject } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), projectPath: z.string() }))
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return {
			...(config ?? {}),
			recentlyProjects: removeRecentlyProject(getProjectRecentProjects(config), input.projectPath)
		}
	})

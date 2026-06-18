import { z } from 'zod'

import { addRecentlyProject, getRecentProjects as getProjectRecentProjects } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'
import { recentProjectSchema } from './schemas'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), project: recentProjectSchema }))
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return { ...(config ?? {}), recentlyProjects: addRecentlyProject(getProjectRecentProjects(config), input.project) }
	})

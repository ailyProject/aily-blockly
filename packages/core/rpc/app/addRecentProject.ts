import { z } from 'zod'

import { addRecentlyProject, getRecentProjects } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

import type { RecentlyProjectEntry } from 'shared'

const recentProjectSchema: z.ZodType<RecentlyProjectEntry> = z.object({
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
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return {
			...(config ?? {}),
			recentlyProjects: addRecentlyProject(getRecentProjects(config), input.project)
		}
	})

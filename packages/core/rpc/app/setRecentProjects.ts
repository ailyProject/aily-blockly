import { z } from 'zod'

import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

import type { RecentlyProjectEntry } from 'shared'

const recentProjectSchema: z.ZodType<RecentlyProjectEntry> = z.object({
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
		...(normalizeAppConfigInput(input.config) ?? {}),
		recentlyProjects: input.projects
	}))

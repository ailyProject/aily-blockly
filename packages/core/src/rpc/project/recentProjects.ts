import { z } from 'zod'

import { addRecentlyProject, getRecentProjects as getProjectRecentProjects, removeRecentlyProject } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

import type { RecentlyProjectEntry } from '@shared'

const recentProjectSchema: z.ZodType<RecentlyProjectEntry> = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string()
})

export const getRecentProjects = p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getProjectRecentProjects(normalizeAppConfigInput(input.config)))

export const setRecentProjects = p
	.input(z.object({ config: appConfigInputSchema.optional(), projects: z.array(recentProjectSchema) }))
	.query(({ input }) => ({ ...(normalizeAppConfigInput(input.config) ?? {}), recentlyProjects: input.projects }))

export const addRecentProject = p
	.input(z.object({ config: appConfigInputSchema.optional(), project: recentProjectSchema }))
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return { ...(config ?? {}), recentlyProjects: addRecentlyProject(getProjectRecentProjects(config), input.project) }
	})

export const removeRecentProject = p
	.input(z.object({ config: appConfigInputSchema.optional(), projectPath: z.string() }))
	.query(({ input }) => {
		const config = normalizeAppConfigInput(input.config)
		return {
			...(config ?? {}),
			recentlyProjects: removeRecentlyProject(getProjectRecentProjects(config), input.projectPath)
		}
	})

import { z } from 'zod'

import {
	addRecentModelProject as addModelProject,
	getRecentModelProjects as getModelProjects,
	removeRecentModelProject as removeModelProject
} from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

import type { RecentModelProject } from 'shared'

const recentModelProjectSchema: z.ZodType<RecentModelProject> = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string(),
	modelType: z.enum(['classification', 'detection', 'segmentation', 'pose']),
	updatedAt: z.string().optional()
})

export const getRecentModelProjects = p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getModelProjects(normalizeAppConfigInput(input.config)))

export const setRecentModelProjects = p
	.input(z.object({ config: appConfigInputSchema.optional(), projects: z.array(recentModelProjectSchema) }))
	.query(({ input }) => ({ ...(normalizeAppConfigInput(input.config) ?? {}), recentModelProjects: input.projects }))

export const addRecentModelProject = p
	.input(z.object({ config: appConfigInputSchema.optional(), project: recentModelProjectSchema }))
	.query(({ input }) => addModelProject(normalizeAppConfigInput(input.config), input.project))

export const removeRecentModelProject = p
	.input(z.object({ config: appConfigInputSchema.optional(), projectPath: z.string() }))
	.query(({ input }) => removeModelProject(normalizeAppConfigInput(input.config), input.projectPath))

import { z } from 'zod'

import {
	addRecentlyProject as addRecentProjectEntry,
	buildProjectDirectoryPath,
	isSameProjectPath as compareProjectPath,
	getDefaultProjectRootPath as getDefaultRootPath,
	removeRecentlyProject as removeRecentProjectEntry,
	resolveProjectRootPath as resolveRootPath
} from '../../project'
import { p } from '../trpc'

const recentProjectEntrySchema = z.object({
	/** 项目主名称 */
	name: z.string(),
	/** 项目绝对路径 */
	path: z.string(),
	/** 可选展示昵称 */
	nickname: z.string().optional()
})

export const addRecentlyProject = p
	.input(
		z.object({
			current: z.array(recentProjectEntrySchema),
			entry: recentProjectEntrySchema,
			maxSize: z.number().optional()
		})
	)
	.query(({ input }) => addRecentProjectEntry(input.current, input.entry, input.maxSize))

export const removeRecentlyProject = p
	.input(z.object({ current: z.array(recentProjectEntrySchema), path: z.string() }))
	.query(({ input }) => removeRecentProjectEntry(input.current, input.path))

export const resolveProjectPath = p
	.input(
		z.object({
			basePath: z.string(),
			name: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => buildProjectDirectoryPath(input.basePath, input.name, input.separator))

export const resolveProjectRootPath = p
	.input(
		z.object({
			template: z.string(),
			userDocuments: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => resolveRootPath(input.template, input.userDocuments, input.separator))

export const getDefaultProjectRootPath = p
	.input(
		z.object({
			userDocuments: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => getDefaultRootPath(input.userDocuments, input.separator))

export const isSameProjectPath = p
	.input(
		z.object({
			leftPath: z.string().optional(),
			rightPath: z.string().optional()
		})
	)
	.query(({ input }) => compareProjectPath(input.leftPath, input.rightPath))

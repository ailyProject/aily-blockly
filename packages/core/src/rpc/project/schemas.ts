import { z } from 'zod'

import type { RecentlyProjectEntry, RecentModelProject } from 'shared'

export const recentProjectSchema: z.ZodType<RecentlyProjectEntry> = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string()
})

export const recentModelProjectSchema: z.ZodType<RecentModelProject> = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	path: z.string(),
	modelType: z.enum(['classification', 'detection', 'segmentation', 'pose']),
	updatedAt: z.string().optional()
})

export const importCloudProjectSchema = z
	.object({
		/** 云端归档下载地址。 */
		archiveUrl: z.string().url().optional(),
		/** 云项目 ID。 */
		projectId: z.string().optional(),
		/** 当通过 projectId 下载时使用的 Bearer token。 */
		authToken: z.string().optional(),
		/** 导入后的目标项目目录。 */
		targetPath: z.string(),
		/** 导入后写入 package.json 的项目主名称。 */
		name: z.string().optional(),
		/** 导入后写入 package.json 的昵称。 */
		nickname: z.string().optional(),
		/** 导入后写入 package.json 的描述。 */
		description: z.string().optional(),
		/** 导入后写入 package.json 的云项目 ID。 */
		cloudId: z.string().optional(),
		/** 导入后写入 package.json 的标签列表。 */
		tags: z.array(z.string()).optional()
	})
	.refine(input => Boolean(input.archiveUrl?.trim() || input.projectId?.trim()), {
		message: 'archiveUrl 或 projectId 至少提供一个'
	})

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

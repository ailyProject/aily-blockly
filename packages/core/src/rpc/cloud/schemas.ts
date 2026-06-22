import { z } from 'zod'

/**
 * 需要认证的云项目动作输入。
 */
export const cloudProjectMutationSchema = z.object({
	projectId: z.string().min(1),
	authToken: z.string().min(1)
})

/**
 * 云项目同步输入。
 */
export const cloudProjectSyncSchema = z.object({
	projectId: z.string().optional(),
	projectData: z.record(z.string(), z.unknown()),
	archivePath: z.string().optional(),
	authToken: z.string().min(1)
})

/**
 * 云项目基础元数据更新输入。
 */
export const cloudProjectUpdateSchema = z.object({
	projectId: z.string().min(1),
	authToken: z.string().min(1),
	nickname: z.string().optional(),
	description: z.string().optional(),
	docUrl: z.string().url().optional(),
	tags: z.array(z.string()).optional(),
	imageBase64: z.string().optional(),
	imageName: z.string().optional(),
	removeCover: z.boolean().optional()
})

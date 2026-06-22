import { z } from 'zod'

import { appSchema, normalizeAppConfigInput } from '../config/schemas'

/**
 * 模型目录列表输入 schema
 */
export const modelCatalogListSchema = z.object({
	config: appSchema.partial().optional(),
	page: z.number().int().min(1).optional(),
	pageSize: z.number().int().min(1).max(100).optional(),
	search: z.string().optional(),
	uniformType: z.string().optional(),
	language: z.string().optional()
})

/**
 * 模型目录详情输入 schema
 */
export const modelCatalogDetailSchema = z.object({
	config: appSchema.partial().optional(),
	modelId: z.string().min(1),
	language: z.string().optional()
})

/**
 * 归一化模型目录列表输入。
 * @param input - 原始输入
 */
export const normalizeModelCatalogListInput = (input: z.infer<typeof modelCatalogListSchema>) => ({
	config: normalizeAppConfigInput(input.config),
	page: input.page,
	pageSize: input.pageSize,
	search: input.search,
	uniformType: input.uniformType,
	language: input.language
})

/**
 * 归一化模型目录详情输入。
 * @param input - 原始输入
 */
export const normalizeModelCatalogDetailInput = (input: z.infer<typeof modelCatalogDetailSchema>) => ({
	config: normalizeAppConfigInput(input.config),
	modelId: input.modelId,
	language: input.language
})

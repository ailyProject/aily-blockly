import { z } from 'zod'

import type { AppDataPathConfig, RegionConfig, ResourceSourceConfig } from 'shared'

export const appDataPathSchema: z.ZodType<AppDataPathConfig> = z.object({
	win32: z.string(),
	darwin: z.string(),
	linux: z.string()
})

export const resourceSourceSchema: z.ZodType<ResourceSourceConfig> = z.object({
	key: z.string(),
	name: z.string().optional(),
	url: z.string(),
	enabled: z.boolean().optional()
})

export const regionSchema: z.ZodType<RegionConfig> = z.object({
	resource: z.string().optional(),
	npm_registry: z.string().optional(),
	api_server: z.string().optional(),
	tool_web: z.string().optional(),
	updater: z.string().optional(),
	web: z.string().optional(),
	ucenter_web: z.string().optional(),
	name: z.string().optional(),
	official: z.boolean().optional(),
	enabled: z.boolean().optional()
})

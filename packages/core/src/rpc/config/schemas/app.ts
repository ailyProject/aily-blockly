import { z } from 'zod'

import { appModelSchema } from './model'
import { recentModelProjectSchema, recentProjectSchema } from './recent'
import { appDataPathSchema, regionSchema, resourceSourceSchema } from './region'
import { quickSendItemSchema, serialMonitorSchema } from './serial'

import type { AilyAppConfig, AppRegistryItem, BuildFlavor } from 'shared'

export const appRegistryItemSchema: z.ZodType<AppRegistryItem> = z.object({
	id: z.string(),
	enabled: z.boolean().optional(),
	lock: z.boolean().optional(),
	dev: z.boolean().optional(),
	router: z.array(z.string()).optional(),
	core: z.array(z.string()).optional()
})

export const appSchema = z.object({
	lang: z.string().optional(),
	theme: z.enum(['dark', 'light', 'default']).optional(),
	font: z.string().optional(),
	platform: z.string().optional(),
	appdata_path: appDataPathSchema.optional(),
	project_path: z.string().optional(),
	build_flavor: z.custom<BuildFlavor>(value => typeof value === 'string').optional(),
	official_region: z.string().optional(),
	region: z.string().optional(),
	resource_source: z.string().optional(),
	resource_sources: z.array(resourceSourceSchema).optional(),
	regions: z.record(z.string(), regionSchema).optional(),
	devmode: z
		.object({
			enabled: z.boolean().optional(),
			autoSave: z.boolean().optional()
		})
		.optional(),
	recentModelProjects: z.array(recentModelProjectSchema).optional(),
	recentlyProjects: z.array(recentProjectSchema).optional(),
	onboardingCompleted: z.boolean().optional(),
	blocklyOnboardingCompleted: z.boolean().optional(),
	ailyChatOnboardingCompleted: z.boolean().optional(),
	selectedLanguage: z.string().optional(),
	toolbarAppIds: z.array(z.string()).optional(),
	skippedVersions: z.array(z.string()).optional(),
	aiChatMode: z.enum(['agent', 'ask']).optional(),
	quickSendList: z.array(quickSendItemSchema).optional(),
	serialMonitor: serialMonitorSchema.optional(),
	aiChatModel: appModelSchema.optional()
})

export const appConfigInputSchema = appSchema.partial()

export const configPatchSchema = z.object({
	versionToSkip: z.string().optional(),
	themeMode: z.enum(['dark', 'light']).optional(),
	aiChatMode: z.enum(['agent', 'ask']).optional(),
	selectedLanguage: z.string().optional(),
	devmodeEnabled: z.boolean().optional(),
	devmodeAutoSave: z.boolean().optional(),
	toolbarAppIds: z.array(z.string()).optional(),
	quickSendList: z.array(quickSendItemSchema).optional(),
	serialMonitor: serialMonitorSchema.optional(),
	clearSkippedVersions: z.boolean().optional()
})

export type AppConfigInput = z.infer<typeof appConfigInputSchema> | undefined

/**
 * 将 RPC 输入侧的配置对象收窄为应用配置类型。
 * @param config - 经过 zod 校验后的输入配置
 */
export const normalizeAppConfigInput = (config: AppConfigInput): AilyAppConfig | undefined =>
	config as AilyAppConfig | undefined

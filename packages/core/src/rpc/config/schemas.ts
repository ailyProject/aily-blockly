import { z } from 'zod'

import type {
	AgentModelConfigOption,
	AilyAppConfig,
	AppDataPathConfig,
	AppRegistryItem,
	BuildFlavor,
	QuickSendItem,
	RecentlyProjectEntry,
	RecentModelProject,
	RegionConfig,
	ResourceSourceConfig,
	SerialMonitorConfig
} from 'shared'

const appDataPathSchema: z.ZodType<AppDataPathConfig> = z.object({
	win32: z.string(),
	darwin: z.string(),
	linux: z.string()
})

const resourceSourceSchema: z.ZodType<ResourceSourceConfig> = z.object({
	key: z.string(),
	name: z.string().optional(),
	url: z.string(),
	enabled: z.boolean().optional()
})

const regionSchema: z.ZodType<RegionConfig> = z.object({
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

export const appModelSchema: z.ZodType<AgentModelConfigOption> = z.object({
	model: z.string(),
	name: z.string(),
	family: z.string(),
	speed: z.string(),
	enabled: z.boolean(),
	isCustom: z.boolean().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().optional(),
	apiKeyId: z.string().optional()
})

export const appRegistryItemSchema: z.ZodType<AppRegistryItem> = z.object({
	id: z.string(),
	enabled: z.boolean().optional(),
	lock: z.boolean().optional(),
	dev: z.boolean().optional(),
	router: z.array(z.string()).optional(),
	core: z.array(z.string()).optional()
})

export const quickSendItemSchema: z.ZodType<QuickSendItem> = z.object({
	name: z.string(),
	type: z.enum(['signal', 'text', 'hex']),
	data: z.string()
})

export const serialMonitorSchema: z.ZodType<SerialMonitorConfig> = z.object({
	port: z.string().optional(),
	baudRate: z.string().optional(),
	dataBits: z.string().optional(),
	stopBits: z.string().optional(),
	parity: z.string().optional(),
	flowControl: z.string().optional()
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

export type AppConfigInput = z.infer<typeof appConfigInputSchema> | undefined

/**
 * 将 RPC 输入侧的配置对象收窄为应用配置类型。
 * @param config - 经过 zod 校验后的输入配置
 */
export const normalizeAppConfigInput = (config: AppConfigInput): AilyAppConfig | undefined =>
	config as AilyAppConfig | undefined

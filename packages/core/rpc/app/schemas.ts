import { z } from 'zod'

export const appModelSchema = z.object({
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

export const appRegistryItemSchema = z.object({
	id: z.string(),
	enabled: z.boolean().optional(),
	lock: z.boolean().optional(),
	dev: z.boolean().optional(),
	router: z.array(z.string()).optional(),
	core: z.array(z.string()).optional()
})

export const quickSendItemSchema = z.object({
	name: z.string(),
	type: z.enum(['signal', 'text', 'hex']),
	data: z.string()
})

export const serialMonitorSchema = z.object({
	port: z.string().optional(),
	baudRate: z.string().optional(),
	dataBits: z.string().optional(),
	stopBits: z.string().optional(),
	parity: z.string().optional(),
	flowControl: z.string().optional()
})

export const appSchema = z.object({
	lang: z.string().optional(),
	theme: z.string().optional(),
	font: z.string().optional(),
	platform: z.string().optional(),
	project_path: z.string().optional(),
	build_flavor: z.string().optional(),
	official_region: z.string().optional(),
	region: z.string().optional(),
	resource_source: z.string().optional(),
	resource_sources: z
		.array(z.object({ key: z.string(), name: z.string().optional(), url: z.string(), enabled: z.boolean().optional() }))
		.optional(),
	regions: z
		.record(
			z.string(),
			z.object({
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
		)
		.optional(),
	selectedLanguage: z.string().optional(),
	toolbarAppIds: z.array(z.string()).optional(),
	skippedVersions: z.array(z.string()).optional(),
	aiChatMode: z.enum(['agent', 'ask']).optional(),
	quickSendList: z.array(quickSendItemSchema).optional(),
	serialMonitor: serialMonitorSchema.optional(),
	aiChatModel: appModelSchema.optional()
})

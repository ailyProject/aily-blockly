import { z } from 'zod'

const toolsSchema = z.object({
	enabledTools: z.array(z.string()),
	disabledTools: z.array(z.string())
})

const modelSchema = z.object({
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

export const agentConfigSchema = z.object({
	useCustomApiKey: z.boolean().optional(),
	maxCount: z.number().optional(),
	enabledTools: z.array(z.string()).optional(),
	disabledTools: z.array(z.string()).optional(),
	agentTools: z.record(z.string(), toolsSchema.optional()).optional(),
	securityWorkspaces: z.object({ project: z.boolean().optional(), library: z.boolean().optional() }).optional(),
	models: z.array(modelSchema).optional()
})

export const agentConfigInputSchema = z.object({
	config: agentConfigSchema.partial().optional()
})

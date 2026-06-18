import { z } from 'zod'

import {
	getAgentToolsConfig,
	getAgentWorkspaceSecurityOptions,
	getEnabledAgentModels,
	normalizeAilyAgentConfig
} from '../agent'
import { p, r } from './trpc'

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

const configSchema = z.object({
	useCustomApiKey: z.boolean().optional(),
	maxCount: z.number().optional(),
	enabledTools: z.array(z.string()).optional(),
	disabledTools: z.array(z.string()).optional(),
	agentTools: z.record(z.string(), toolsSchema.optional()).optional(),
	securityWorkspaces: z.object({ project: z.boolean().optional(), library: z.boolean().optional() }).optional(),
	models: z.array(modelSchema).optional()
})

/**
 * 暴露 agent 配置归一化与只读规则。
 */
export default r({
	normalize: p.input(z.object({ config: configSchema.partial().optional() })).query(({ input }) => {
		return normalizeAilyAgentConfig(input.config)
	}),
	getEnabledModels: p
		.input(z.object({ config: configSchema.partial().optional() }))
		.query(({ input }) => getEnabledAgentModels(normalizeAilyAgentConfig(input.config))),
	getTools: p
		.input(z.object({ config: configSchema.partial().optional(), agentName: z.string() }))
		.query(({ input }) => getAgentToolsConfig(normalizeAilyAgentConfig(input.config), input.agentName)),
	getSecurityOptions: p
		.input(z.object({ config: configSchema.partial().optional() }))
		.query(({ input }) => getAgentWorkspaceSecurityOptions(normalizeAilyAgentConfig(input.config)))
})

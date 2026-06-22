import { z } from 'zod'

import type { AgentModelConfigOption } from 'shared'

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

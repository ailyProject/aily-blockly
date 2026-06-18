import { z } from 'zod'

export const childToolListSchema = z.object({
	childPath: z.string().optional()
})

export const childToolGetSchema = z.object({
	toolId: z.string(),
	childPath: z.string().optional()
})

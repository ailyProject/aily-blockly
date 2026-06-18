import { z } from 'zod'

import { appRegistryItemSchema } from '../config/schemas'

export const appStoreLayoutSchema = z.object({
	version: z.literal(2),
	zones: z.object({
		header: z.array(z.string())
	})
})

export const appVisibilityContextSchema = z
	.object({
		routeUrl: z.string().optional(),
		boardCore: z.string().optional(),
		isDevMode: z.boolean().optional()
	})
	.optional()

export { appRegistryItemSchema }

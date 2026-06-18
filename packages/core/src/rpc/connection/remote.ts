import { z } from 'zod'

import { syncConnectionPinmapComponentsFromApi } from '../../connection'
import { appSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export const syncCloudPinmaps = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			packagesBasePath: z.string(),
			pinmapIdHints: z.array(z.string()).optional(),
			authToken: z.string().optional(),
			headers: z.record(z.string(), z.string()).optional()
		})
	)
	.mutation(({ input }) =>
		syncConnectionPinmapComponentsFromApi({
			config: normalizeAppConfigInput(input.config),
			packagesBasePath: input.packagesBasePath,
			pinmapIdHints: input.pinmapIdHints,
			authToken: input.authToken,
			headers: input.headers
		})
	)

import { z } from 'zod'

import { saveConnectionPinmapConfig } from '../../connection'
import { p } from '../trpc'

const pinmapConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	width: z.number(),
	height: z.number(),
	images: z.array(z.record(z.string(), z.unknown())),
	pins: z.array(z.record(z.string(), z.unknown())),
	functionTypes: z.array(z.record(z.string(), z.unknown())).optional()
})

export default p
	.input(
		z.object({
			pinmapId: z.string(),
			packagesBasePath: z.string(),
			catalogVersion: z.union([z.string(), z.number()]).optional(),
			config: pinmapConfigSchema
		})
	)
	.mutation(({ input }) =>
		saveConnectionPinmapConfig(input.pinmapId, input.config as never, input.packagesBasePath, input.catalogVersion)
	)

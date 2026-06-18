import { z } from 'zod'

import { getConnectionLibraryInfo, getConnectionPinmapTemplate, saveConnectionPinmapConfig } from '../../connection'
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

export const getLibraryInfo = p
	.input(z.object({ pinmapId: z.string(), packagesBasePath: z.string() }))
	.query(({ input }) => getConnectionLibraryInfo(input.pinmapId, input.packagesBasePath))

export const getPinmapTemplate = p
	.input(z.object({ protocol: z.string().optional() }))
	.query(({ input }) => getConnectionPinmapTemplate(input.protocol))

export const savePinmap = p
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

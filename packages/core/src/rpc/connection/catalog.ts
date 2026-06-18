import { z } from 'zod'

import {
	getAvailableConnectionPinmapIds,
	getConnectionSensorPickerData,
	scanConnectionLibraries,
	scanConnectionPinmapCatalogs
} from '../../connection'
import { p } from '../trpc'

export const listCatalogs = p
	.input(z.object({ packagesBasePath: z.string() }))
	.query(({ input }) => scanConnectionPinmapCatalogs(input.packagesBasePath))

export const listLibraries = p
	.input(z.object({ packagesBasePath: z.string() }))
	.query(({ input }) => scanConnectionLibraries(input.packagesBasePath))

export const listAvailablePinmapIds = p
	.input(
		z.object({
			packagesBasePath: z.string(),
			status: z.enum(['available', 'needs_generation']).optional(),
			type: z.enum(['library', 'board', 'software']).optional(),
			protocol: z.string().optional()
		})
	)
	.query(({ input }) =>
		getAvailableConnectionPinmapIds(input.packagesBasePath, {
			status: input.status,
			type: input.type,
			protocol: input.protocol
		})
	)

export const getSensorPickerData = p
	.input(z.object({ packagesBasePath: z.string() }))
	.query(({ input }) => getConnectionSensorPickerData(input.packagesBasePath))

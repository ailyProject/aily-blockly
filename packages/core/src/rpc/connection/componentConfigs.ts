import { z } from 'zod'

import { collectConnectionComponentConfigs } from '../../connection'
import { p } from '../trpc'
import { connectionGraphSchema } from './schemas'

export const collectConfigs = p
	.input(
		z.object({
			boardPackagePath: z.string(),
			packagesBasePath: z.string().optional(),
			connectionData: connectionGraphSchema
		})
	)
	.query(({ input }) =>
		collectConnectionComponentConfigs(input.boardPackagePath, input.connectionData, input.packagesBasePath)
	)

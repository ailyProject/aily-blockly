import { z } from 'zod'

import { getHardwareModelFile } from '../../hardware'
import { appSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export const getModelFile = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			modelId: z.string()
		})
	)
	.query(({ input }) =>
		getHardwareModelFile({
			config: normalizeAppConfigInput(input.config),
			modelId: input.modelId
		})
	)

import { z } from 'zod'

import { applyProjectConfigPatch } from '../../project'
import { p } from '../trpc'
import { appSchema, configPatchSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			...configPatchSchema.shape
		})
	)
	.query(({ input }) => applyProjectConfigPatch(normalizeAppConfigInput(input.config), input))

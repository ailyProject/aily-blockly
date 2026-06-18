import { z } from 'zod'

import { buildConnectionPrompt } from '../../connection'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			boardPackagePath: z.string(),
			peripheralConfigPaths: z.array(z.string()).optional(),
			extraRequirements: z.string().optional()
		})
	)
	.query(({ input }) =>
		buildConnectionPrompt(input.boardPackagePath, input.peripheralConfigPaths, input.extraRequirements)
	)

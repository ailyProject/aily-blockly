import { z } from 'zod'

import { generatePinSummaries } from '../../connection'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			boardPackagePath: z.string(),
			peripheralConfigPaths: z.array(z.string()).optional()
		})
	)
	.query(({ input }) => generatePinSummaries(input.boardPackagePath, input.peripheralConfigPaths))

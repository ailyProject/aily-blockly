import { z } from 'zod'

import { resolveFfsBaudrate } from '../../ffs'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			portPath: z.string(),
			requestedBaud: z.number().int().positive()
		})
	)
	.query(({ input }) => resolveFfsBaudrate(input.portPath, input.requestedBaud))

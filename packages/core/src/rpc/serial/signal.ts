import { z } from 'zod'

import { setSerialSessionSignal } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			port: z.string(),
			signal: z.enum(['dtr', 'rts']),
			enabled: z.boolean().optional()
		})
	)
	.query(({ input }) => setSerialSessionSignal(input))

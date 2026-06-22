import { z } from 'zod'

import { sendSerialSessionData } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			port: z.string(),
			data: z.string(),
			mode: z.enum(['text', 'hex']),
			endR: z.boolean().optional(),
			endN: z.boolean().optional()
		})
	)
	.query(({ input }) => sendSerialSessionData(input))

import { z } from 'zod'

import { connectSerialSession } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			path: z.string(),
			baudRate: z.number().int().positive(),
			dataBits: z.number().int().positive(),
			stopBits: z.number().positive(),
			parity: z.string(),
			flowControl: z.string()
		})
	)
	.query(({ input }) => connectSerialSession(input))

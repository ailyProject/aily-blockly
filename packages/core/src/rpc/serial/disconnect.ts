import { z } from 'zod'

import { disconnectSerialSession } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			port: z.string()
		})
	)
	.query(({ input }) => disconnectSerialSession(input.port))

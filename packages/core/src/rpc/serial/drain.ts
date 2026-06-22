import { z } from 'zod'

import { drainSerialSessionMessages } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			port: z.string()
		})
	)
	.query(({ input }) => drainSerialSessionMessages(input.port))

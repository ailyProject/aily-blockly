import { z } from 'zod'

import { getSerialSessionSnapshot } from '../../serial'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			port: z.string()
		})
	)
	.query(({ input }) => getSerialSessionSnapshot(input.port))

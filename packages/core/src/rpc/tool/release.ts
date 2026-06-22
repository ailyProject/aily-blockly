import { z } from 'zod'

import { releaseChildToolHost } from '../../tool'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			toolId: z.string()
		})
	)
	.query(({ input }) => releaseChildToolHost(input))

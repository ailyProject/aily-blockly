import { z } from 'zod'

import { acquireChildToolHost } from '../../tool'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			toolId: z.string(),
			childPath: z.string().optional()
		})
	)
	.query(({ input }) => acquireChildToolHost(input))

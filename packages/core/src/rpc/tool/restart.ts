import { z } from 'zod'

import { restartChildToolHost } from '../../tool'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			toolId: z.string(),
			childPath: z.string().optional()
		})
	)
	.query(({ input }) => restartChildToolHost(input))

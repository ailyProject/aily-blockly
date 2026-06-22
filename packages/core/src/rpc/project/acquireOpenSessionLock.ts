import { z } from 'zod'

import { acquireProjectOpenSessionLock } from '../../project'
import { p } from '../trpc'

/**
 * 申请当前项目的打开会话锁。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			owner: z.string(),
			pid: z.number().int().positive()
		})
	)
	.mutation(({ input }) => acquireProjectOpenSessionLock(input))

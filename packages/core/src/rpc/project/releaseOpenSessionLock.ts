import { z } from 'zod'

import { releaseProjectOpenSessionLock } from '../../project'
import { p } from '../trpc'

/**
 * 释放当前项目的打开会话锁。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			pid: z.number().int().positive().optional()
		})
	)
	.mutation(({ input }) => releaseProjectOpenSessionLock(input))

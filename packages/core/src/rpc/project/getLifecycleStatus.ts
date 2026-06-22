import { z } from 'zod'

import { getProjectLifecycleStatus } from '../../project'
import { p } from '../trpc'

/**
 * 读取当前项目生命周期状态摘要。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => getProjectLifecycleStatus(input.projectPath))

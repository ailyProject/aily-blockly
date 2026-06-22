import { z } from 'zod'

import { removeStoredRecentProject } from '../../project'
import { p } from '../trpc'

/**
 * 从 appDataPath/config.json 移除最近项目条目。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			projectPath: z.string()
		})
	)
	.mutation(({ input }) => removeStoredRecentProject(input))

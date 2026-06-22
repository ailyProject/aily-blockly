import { z } from 'zod'

import { syncProjectToCloud } from '../../project'
import { p } from '../trpc'

/**
 * 打包当前本地项目并同步到云端。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			authToken: z.string().min(1)
		})
	)
	.mutation(({ input }) => syncProjectToCloud(input))

import { z } from 'zod'

import { addStoredRecentProject } from '../../project'
import { p } from '../trpc'
import { recentProjectSchema } from './schemas'

/**
 * 把最近项目条目持久化写回 appDataPath/config.json。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			project: recentProjectSchema
		})
	)
	.mutation(({ input }) => addStoredRecentProject(input))

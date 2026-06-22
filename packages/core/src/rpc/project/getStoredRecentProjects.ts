import { z } from 'zod'

import { readStoredRecentProjects } from '../../project'
import { p } from '../trpc'

/**
 * 从 appDataPath/config.json 读取最近项目列表。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string()
		})
	)
	.query(({ input }) => readStoredRecentProjects(input))

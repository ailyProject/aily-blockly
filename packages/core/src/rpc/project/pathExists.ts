import { z } from 'zod'

import { projectPathExists } from '../../project'
import { p } from '../trpc'

/**
 * 判断目标项目路径是否已存在。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => projectPathExists(input.projectPath))

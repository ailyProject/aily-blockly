import { z } from 'zod'

import { readProjectAbiSummary } from '../../project'
import { p } from '../trpc'

/**
 * 读取项目 `project.abi` 的摘要信息。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => readProjectAbiSummary(input.projectPath))

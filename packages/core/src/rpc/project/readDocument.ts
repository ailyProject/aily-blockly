import { z } from 'zod'

import { readProjectDocument } from '../../project'
import { p } from '../trpc'

/**
 * 读取项目 `project.abi` 的归一化文档。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => readProjectDocument(input.projectPath))

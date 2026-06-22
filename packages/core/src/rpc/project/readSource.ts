import { z } from 'zod'

import { readProjectSource } from '../../project'
import { p } from '../trpc'

/**
 * 读取项目当前可复用的源码入口。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => readProjectSource(input.projectPath))

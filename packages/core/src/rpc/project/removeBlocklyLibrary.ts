import { z } from 'zod'

import { removeProjectBlocklyLibrary } from '../../project'
import { p } from '../trpc'

/**
 * 从当前项目目录移除 Blockly 库依赖。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			packageName: z.string()
		})
	)
	.mutation(({ input }) => removeProjectBlocklyLibrary(input))

import { z } from 'zod'

import { installProjectBlocklyLibrary } from '../../project'
import { p } from '../trpc'

/**
 * 在当前项目目录安装 Blockly 库依赖。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			packageName: z.string(),
			version: z.string().optional(),
			localPath: z.string().optional()
		})
	)
	.mutation(({ input }) => installProjectBlocklyLibrary(input))

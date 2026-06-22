import { z } from 'zod'

import { getProjectBlocklyLibraryStatus } from '../../project'
import { p } from '../trpc'

/**
 * 读取当前项目的 Blockly 库状态摘要。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => getProjectBlocklyLibraryStatus(input.projectPath))

import { z } from 'zod'

import { getProjectBlocklyLibraryActionStatus } from '../../project'
import { p } from '../trpc'

/**
 * 读取当前 Blockly 库 install/remove 动作的实时状态。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			packageName: z.string(),
			action: z.enum(['install', 'remove'])
		})
	)
	.query(({ input }) => getProjectBlocklyLibraryActionStatus(input))

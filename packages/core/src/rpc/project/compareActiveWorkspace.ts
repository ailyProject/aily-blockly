import { z } from 'zod'

import { compareProjectActiveWorkspace } from '../../project'
import { p } from '../trpc'

/**
 * 比较新的 workspace payload 是否会改变当前激活页面文档。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			payload: z.unknown()
		})
	)
	.query(({ input }) => compareProjectActiveWorkspace(input.projectPath, input.payload))

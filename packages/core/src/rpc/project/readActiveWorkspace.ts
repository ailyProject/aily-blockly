import { z } from 'zod'

import { readProjectActiveWorkspace } from '../../project'
import { p } from '../trpc'

/**
 * 读取项目当前激活页面的合成 workspace payload。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => readProjectActiveWorkspace(input.projectPath))

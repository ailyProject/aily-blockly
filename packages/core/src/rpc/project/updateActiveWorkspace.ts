import { z } from 'zod'

import { updateProjectActiveWorkspace } from '../../project'
import { p } from '../trpc'

/**
 * 用新的 workspace payload 更新当前激活页面及共享模型。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			payload: z.unknown()
		})
	)
	.mutation(({ input }) => updateProjectActiveWorkspace(input.projectPath, input.payload))

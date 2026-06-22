import { z } from 'zod'

import { updateProjectActiveViewState } from '../../project'
import { p } from '../trpc'

/**
 * 更新当前激活页面的视图状态。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			viewState: z.object({
				scale: z.number(),
				scrollX: z.number(),
				scrollY: z.number()
			})
		})
	)
	.mutation(({ input }) => updateProjectActiveViewState(input.projectPath, input.viewState))

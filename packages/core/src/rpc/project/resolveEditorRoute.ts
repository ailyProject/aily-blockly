import { z } from 'zod'

import { resolveProjectEditorRoute } from '../../project'
import { p } from '../trpc'

/**
 * 根据项目内容推断应打开的编辑器路由。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => resolveProjectEditorRoute(input.projectPath))

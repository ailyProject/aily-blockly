import { z } from 'zod'

import { openProjectDocumentPage } from '../../project'
import { p } from '../trpc'

/**
 * 打开项目文档页面，并可选激活。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			pageId: z.string(),
			activate: z.boolean().optional()
		})
	)
	.mutation(({ input }) => openProjectDocumentPage(input.projectPath, input.pageId, input.activate))

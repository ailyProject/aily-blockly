import { z } from 'zod'

import { closeProjectDocumentPage } from '../../project'
import { p } from '../trpc'

/**
 * 关闭项目文档页面。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			pageId: z.string()
		})
	)
	.mutation(({ input }) => closeProjectDocumentPage(input.projectPath, input.pageId))

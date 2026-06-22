import { z } from 'zod'

import { renameProjectDocumentPage } from '../../project'
import { p } from '../trpc'

/**
 * 重命名项目文档页面。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			pageId: z.string(),
			title: z.string()
		})
	)
	.mutation(({ input }) => renameProjectDocumentPage(input.projectPath, input.pageId, input.title))

import { z } from 'zod'

import { switchProjectDocumentPage } from '../../project'
import { p } from '../trpc'

/**
 * 切换项目文档当前激活页面。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			pageId: z.string()
		})
	)
	.mutation(({ input }) => switchProjectDocumentPage(input.projectPath, input.pageId))

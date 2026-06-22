import { z } from 'zod'

import { createProjectDocumentPage } from '../../project'
import { p } from '../trpc'

/**
 * 在项目文档中新增页面并激活。
 */
export default p
	.input(
		z.object({
			projectPath: z.string(),
			title: z.string().optional()
		})
	)
	.mutation(({ input }) => createProjectDocumentPage(input.projectPath, input.title))

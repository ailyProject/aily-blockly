import { z } from 'zod'

import { getProjectCloudBinding } from '../../project'
import { p } from '../trpc'

/**
 * 读取当前本地项目与云项目的绑定摘要。
 */
export default p
	.input(
		z.object({
			projectPath: z.string()
		})
	)
	.query(({ input }) => getProjectCloudBinding(input.projectPath))

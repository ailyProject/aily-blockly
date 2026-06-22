import { z } from 'zod'

import { findAvailableProjectName } from '../../project'
import { p } from '../trpc'

/**
 * 查找当前根目录下可用的项目名。
 */
export default p
	.input(
		z.object({
			basePath: z.string(),
			name: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => findAvailableProjectName(input.basePath, input.name, input.separator))

import { z } from 'zod'

import { validateProjectName } from '../../project'
import { p } from '../trpc'

/**
 * 校验项目名称是否合法。
 */
export default p
	.input(
		z.object({
			name: z.string(),
			platform: z.string().optional()
		})
	)
	.query(({ input }) => validateProjectName(input.name, input.platform))

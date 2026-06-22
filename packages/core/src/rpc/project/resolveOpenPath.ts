import { z } from 'zod'

import { resolveProjectOpenPath } from '../../project'
import { p } from '../trpc'

/**
 * 把用户选中的文件或目录路径解析成项目根目录。
 */
export default p
	.input(
		z.object({
			path: z.string()
		})
	)
	.query(({ input }) => resolveProjectOpenPath(input.path))

import { z } from 'zod'

import { formatAbs } from '../../abs'
import { p } from '../trpc'

/**
 * 格式化 ABS 文本。
 */
export default p
	.input(
		z.object({
			abs: z.string()
		})
	)
	.query(({ input }) => ({
		abs: formatAbs(input.abs)
	}))

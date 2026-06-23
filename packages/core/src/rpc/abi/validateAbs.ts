import { z } from 'zod'

import { validateAbs } from '../../abs'
import { p } from '../trpc'

/**
 * 校验 ABS 文本语法。
 */
export default p
	.input(
		z.object({
			abs: z.string()
		})
	)
	.query(({ input }) => validateAbs(input.abs))

import { z } from 'zod'

import { convertAbsToAbi } from '../../abs'
import { p } from '../trpc'

/**
 * 将 ABS 文本转换为 ABI payload。
 */
export default p
	.input(
		z.object({
			abs: z.string()
		})
	)
	.query(({ input }) => convertAbsToAbi(input.abs))

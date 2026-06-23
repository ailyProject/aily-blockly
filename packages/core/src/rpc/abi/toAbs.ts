import { z } from 'zod'

import { convertAbiToAbsWithLineMap } from '../../abs'
import { p } from '../trpc'

const abiToAbsOptionsSchema = z
	.object({
		includeHeader: z.boolean().optional(),
		indentStr: z.string().optional(),
		includeBlockIds: z.boolean().optional(),
		explicitBlockTypes: z.boolean().optional()
	})
	.optional()

/**
 * 将 ABI payload 转换为 ABS 文本。
 */
export default p
	.input(
		z.object({
			payload: z.unknown(),
			options: abiToAbsOptionsSchema
		})
	)
	.query(({ input }) => {
		const result = convertAbiToAbsWithLineMap(input.payload, input.options)
		return {
			abs: result.abs,
			blockLineMap: Object.fromEntries(result.blockLineMap.entries())
		}
	})

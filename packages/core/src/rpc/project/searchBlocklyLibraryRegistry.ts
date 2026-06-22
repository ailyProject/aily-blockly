import { z } from 'zod'

import { searchProjectBlocklyLibraryRegistry } from '../../project'
import { p } from '../trpc'

/**
 * 在当前 npm registry 中搜索 Blockly 库。
 */
export default p
	.input(
		z.object({
			query: z.string(),
			registry: z.string().url().optional(),
			limit: z.number().int().positive().optional()
		})
	)
	.query(({ input }) => searchProjectBlocklyLibraryRegistry(input))

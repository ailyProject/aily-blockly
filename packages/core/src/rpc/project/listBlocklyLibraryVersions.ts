import { z } from 'zod'

import { listProjectBlocklyLibraryVersions } from '../../project'
import { p } from '../trpc'

/**
 * 读取当前 Blockly 库在 registry 中可见的版本列表。
 */
export default p
	.input(
		z.object({
			packageName: z.string(),
			registry: z.string().url().optional()
		})
	)
	.query(({ input }) => listProjectBlocklyLibraryVersions(input))

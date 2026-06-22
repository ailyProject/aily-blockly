import { z } from 'zod'

import { inspectProjectBlocklyLibrarySource } from '../../project'
import { p } from '../trpc'

/**
 * 检查本地目录是否可作为 Blockly 库导入。
 */
export default p
	.input(
		z.object({
			localPath: z.string()
		})
	)
	.query(({ input }) => inspectProjectBlocklyLibrarySource(input.localPath))

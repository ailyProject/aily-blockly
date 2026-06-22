import { z } from 'zod'

import { readProjectConfigFile } from '../../project'
import { p } from '../trpc'
import { resolveConfigSummary } from './summary'

/**
 * 从 `${appDataPath}/config.json` 读取并规整配置摘要。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			fallbackLanguage: z.string().optional(),
			userHome: z.string().optional()
		})
	)
	.query(({ input }) => resolveConfigSummary(readProjectConfigFile({ appDataPath: input.appDataPath }), input))

import { z } from 'zod'

import { installHardwareEsptool } from '../../hardware'
import { p } from '../trpc'

/**
 * 在宿主 appData 目录安装 esptool 包。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			platform: z.enum(['windows', 'macos', 'linux']),
			packageSpec: z.string().optional()
		})
	)
	.mutation(({ input }) =>
		installHardwareEsptool({
			appDataPath: input.appDataPath,
			platform: input.platform,
			packageSpec: input.packageSpec
		})
	)

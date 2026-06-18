import { z } from 'zod'

import { installHardwareEsptool } from '../../hardware'
import { p } from '../trpc'

export const installEsptool = p
	.input(
		z.object({
			appDataPath: z.string(),
			platform: z.enum(['windows', 'macos', 'linux']),
			packageSpec: z.string().optional()
		})
	)
	.mutation(({ input }) => installHardwareEsptool(input))

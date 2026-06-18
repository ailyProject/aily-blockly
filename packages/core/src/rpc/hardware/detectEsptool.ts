import { z } from 'zod'

import { detectHardwareEsptool } from '../../hardware'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			appDataPath: z.string(),
			platform: z.enum(['windows', 'macos', 'linux'])
		})
	)
	.query(({ input }) => detectHardwareEsptool(input))

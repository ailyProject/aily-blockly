import { z } from 'zod'

import { resolveHardwareEsptoolTempDir } from '../../hardware'
import { p } from '../trpc'

export const resolveEsptoolTempDir = p
	.input(
		z.object({
			appDataPath: z.string()
		})
	)
	.query(({ input }) => resolveHardwareEsptoolTempDir(input.appDataPath))

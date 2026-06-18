import { z } from 'zod'

import { buildSerialMonitorConnectOptions } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const buildSerialConnectOptions = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			port: z.string().optional()
		})
	)
	.query(({ input }) => buildSerialMonitorConnectOptions(input.config?.serialMonitor ?? {}, input.port))

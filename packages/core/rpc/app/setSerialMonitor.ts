import { z } from 'zod'

import { setSerialMonitorConfig } from '../../project'
import { p } from '../trpc'
import { appSchema, serialMonitorSchema } from './schemas'

export const setSerialMonitor = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			serialMonitor: serialMonitorSchema
		})
	)
	.query(({ input }) => setSerialMonitorConfig(input.config, input.serialMonitor))

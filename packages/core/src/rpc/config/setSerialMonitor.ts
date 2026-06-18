import { z } from 'zod'

import { setSerialMonitorConfig } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput, serialMonitorSchema } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			serialMonitor: serialMonitorSchema
		})
	)
	.query(({ input }) => setSerialMonitorConfig(normalizeAppConfigInput(input.config), input.serialMonitor))

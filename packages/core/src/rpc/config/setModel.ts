import { z } from 'zod'

import { setAiChatModel } from '../../project'
import { p } from '../trpc'
import { appModelSchema, appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			model: appModelSchema
		})
	)
	.query(({ input }) => setAiChatModel(normalizeAppConfigInput(input.config), input.model))

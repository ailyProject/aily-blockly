import { z } from 'zod'

import { setAiChatModel } from '../../project'
import { p } from '../trpc'
import { appModelSchema, appSchema } from './schemas'

export const setModel = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			model: appModelSchema
		})
	)
	.query(({ input }) => setAiChatModel(input.config, input.model))

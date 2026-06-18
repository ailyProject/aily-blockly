import { z } from 'zod'

import { resolveAiChatModelSelection } from '../../project'
import { p } from '../trpc'
import { appModelSchema, appSchema } from './schemas'

export const resolveModel = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			enabledModels: z.array(appModelSchema)
		})
	)
	.query(({ input }) => resolveAiChatModelSelection(input.config, input.enabledModels))

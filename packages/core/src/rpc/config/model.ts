import { z } from 'zod'

import { resolveAiChatModelSelection } from '../../project'
import { p } from '../trpc'
import { appModelSchema, appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			enabledModels: z.array(appModelSchema)
		})
	)
	.query(({ input }) => resolveAiChatModelSelection(normalizeAppConfigInput(input.config), input.enabledModels))

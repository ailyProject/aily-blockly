import { z } from 'zod'

import { completeOnboarding as completeOnboardingState } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			config: appConfigInputSchema.optional(),
			key: z.enum(['onboardingCompleted', 'blocklyOnboardingCompleted', 'ailyChatOnboardingCompleted'])
		})
	)
	.query(({ input }) => completeOnboardingState(normalizeAppConfigInput(input.config), input.key))

import { z } from 'zod'

import { completeOnboarding as completeOnboardingState } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const completeOnboarding = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			key: z.enum(['onboardingCompleted', 'blocklyOnboardingCompleted', 'ailyChatOnboardingCompleted'])
		})
	)
	.query(({ input }) => completeOnboardingState(input.config, input.key))

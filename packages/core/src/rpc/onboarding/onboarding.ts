import { z } from 'zod'

import { completeOnboarding as completeOnboardingState, getOnboardingState } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export const getOnboarding = p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getOnboardingState(normalizeAppConfigInput(input.config)))

export const completeOnboarding = p
	.input(
		z.object({
			config: appConfigInputSchema.optional(),
			key: z.enum(['onboardingCompleted', 'blocklyOnboardingCompleted', 'ailyChatOnboardingCompleted'])
		})
	)
	.query(({ input }) => completeOnboardingState(normalizeAppConfigInput(input.config), input.key))

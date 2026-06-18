import { z } from 'zod'

import { getOnboardingState } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const getOnboarding = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => getOnboardingState(normalizeAppConfigInput(input.config)))

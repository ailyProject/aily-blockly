import { z } from 'zod'

import { getOnboardingState } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getOnboardingState(normalizeAppConfigInput(input.config)))

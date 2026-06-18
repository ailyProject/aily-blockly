import { z } from 'zod'

import { getRecentModelProjects as getModelProjects } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getModelProjects(normalizeAppConfigInput(input.config)))

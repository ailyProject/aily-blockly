import { z } from 'zod'

import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'
import { recentModelProjectSchema } from './schemas'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), projects: z.array(recentModelProjectSchema) }))
	.query(({ input }) => ({ ...(normalizeAppConfigInput(input.config) ?? {}), recentModelProjects: input.projects }))

import { z } from 'zod'

import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'
import { recentProjectSchema } from './schemas'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), projects: z.array(recentProjectSchema) }))
	.query(({ input }) => ({ ...(normalizeAppConfigInput(input.config) ?? {}), recentlyProjects: input.projects }))

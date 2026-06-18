import { z } from 'zod'

import { getRecentProjects as getProjectRecentProjects } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(z.object({ config: appConfigInputSchema.optional() }))
	.query(({ input }) => getProjectRecentProjects(normalizeAppConfigInput(input.config)))

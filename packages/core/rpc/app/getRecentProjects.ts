import { z } from 'zod'

import { getRecentProjects as getConfigRecentProjects } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const getRecentProjects = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => getConfigRecentProjects(input.config))

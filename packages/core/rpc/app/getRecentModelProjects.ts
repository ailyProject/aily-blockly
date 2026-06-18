import { z } from 'zod'

import { getRecentModelProjects as getConfigRecentModelProjects } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const getRecentModelProjects = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => getConfigRecentModelProjects(normalizeAppConfigInput(input.config)))

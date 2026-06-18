import { z } from 'zod'

import { getRecentModelProjects } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const getRecentModelProjects = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => getRecentModelProjects(input.config))

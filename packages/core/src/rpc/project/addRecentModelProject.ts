import { z } from 'zod'

import { addRecentModelProject as addModelProject } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'
import { recentModelProjectSchema } from './schemas'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), project: recentModelProjectSchema }))
	.query(({ input }) => addModelProject(normalizeAppConfigInput(input.config), input.project))

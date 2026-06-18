import { z } from 'zod'

import { removeRecentModelProject as removeModelProject } from '../../project'
import { appConfigInputSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export default p
	.input(z.object({ config: appConfigInputSchema.optional(), projectPath: z.string() }))
	.query(({ input }) => removeModelProject(normalizeAppConfigInput(input.config), input.projectPath))

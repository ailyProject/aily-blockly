import { z } from 'zod'

import { removeRecentModelProject as removeRecentModelProjectConfig } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const removeRecentModelProject = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			projectPath: z.string()
		})
	)
	.query(({ input }) => removeRecentModelProjectConfig(normalizeAppConfigInput(input.config), input.projectPath))

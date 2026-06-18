import { z } from 'zod'

import { clearSkippedAppVersions } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export const clearSkippedVersions = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => clearSkippedAppVersions(normalizeAppConfigInput(input.config)))

import { z } from 'zod'

import { toggleThemeMode } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

export default p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => toggleThemeMode(normalizeAppConfigInput(input.config)))

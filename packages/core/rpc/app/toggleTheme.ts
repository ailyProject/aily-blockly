import { z } from 'zod'

import { toggleThemeMode } from '../../project'
import { p } from '../trpc'
import { appSchema } from './schemas'

export const toggleTheme = p
	.input(z.object({ config: appSchema.partial().optional() }))
	.query(({ input }) => toggleThemeMode(input.config))

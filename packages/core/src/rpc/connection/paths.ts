import { z } from 'zod'

import { resolveConnectionGraphPaths } from '../../connection'
import { p } from '../trpc'

export const resolvePaths = p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => resolveConnectionGraphPaths(input.projectPath))

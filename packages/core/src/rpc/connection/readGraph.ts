import { z } from 'zod'

import { readConnectionGraph } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => readConnectionGraph(input.projectPath))

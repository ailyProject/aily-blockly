import { z } from 'zod'

import { hasConnectionGraph } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => hasConnectionGraph(input.projectPath))

import { z } from 'zod'

import { saveConnectionAws } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ projectPath: z.string(), content: z.string() }))
	.mutation(({ input }) => saveConnectionAws(input.content, input.projectPath))

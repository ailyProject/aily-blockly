import { z } from 'zod'

import { saveConnectionGraph } from '../../connection'
import { p } from '../trpc'
import { connectionGraphSchema } from './schemas'

export default p
	.input(z.object({ projectPath: z.string(), data: connectionGraphSchema }))
	.mutation(({ input }) => saveConnectionGraph(input.data, input.projectPath))

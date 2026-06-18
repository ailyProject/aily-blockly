import { z } from 'zod'

import { isSameProjectPath as compareProjectPath } from '../../project'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			leftPath: z.string().optional(),
			rightPath: z.string().optional()
		})
	)
	.query(({ input }) => compareProjectPath(input.leftPath, input.rightPath))

import { z } from 'zod'

import { buildProjectDirectoryPath } from '../../project'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			basePath: z.string(),
			name: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => buildProjectDirectoryPath(input.basePath, input.name, input.separator))

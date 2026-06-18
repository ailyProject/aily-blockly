import { z } from 'zod'

import { resolveProjectRootPath as resolveRootPath } from '../../project'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			template: z.string(),
			userDocuments: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => resolveRootPath(input.template, input.userDocuments, input.separator))

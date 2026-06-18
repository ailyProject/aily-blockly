import { z } from 'zod'

import { getDefaultProjectRootPath as getDefaultRootPath } from '../../project'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			userDocuments: z.string(),
			separator: z.string()
		})
	)
	.query(({ input }) => getDefaultRootPath(input.userDocuments, input.separator))

import { z } from 'zod'

import { getLibraryCategories } from '../../hardware'
import { p } from '../trpc'
import { libraryIndexItemSchema } from './schemas'

export default p
	.input(
		z.object({
			libraries: z.array(libraryIndexItemSchema),
			dimension: z.enum(['category', 'hardwareType', 'communication', 'supportedCores'])
		})
	)
	.query(({ input }) => getLibraryCategories(input.libraries, input.dimension))

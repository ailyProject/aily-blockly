import { z } from 'zod'

import { getBoardCategories } from '../../hardware'
import { p } from '../trpc'
import { boardIndexItemSchema } from './schemas'

export default p
	.input(
		z.object({
			boards: z.array(boardIndexItemSchema),
			dimension: z.enum(['brand', 'architecture', 'connectivity', 'interfaces', 'tags'])
		})
	)
	.query(({ input }) => getBoardCategories(input.boards, input.dimension))

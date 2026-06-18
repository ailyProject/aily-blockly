import { z } from 'zod'

import { validateLegacyBoard } from '../../hardware'
import { p } from '../trpc'
import { legacyBoardItemSchema } from './schemas'

export default p
	.input(z.object({ boardName: z.string(), boards: z.array(legacyBoardItemSchema) }))
	.query(({ input }) => validateLegacyBoard(input.boardName, input.boards))

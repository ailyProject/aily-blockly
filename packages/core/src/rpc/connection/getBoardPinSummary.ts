import { z } from 'zod'

import { readBoardPinSummary } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ boardPackagePath: z.string() }))
	.query(({ input }) => readBoardPinSummary(input.boardPackagePath))

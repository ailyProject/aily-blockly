import { z } from 'zod'

import { loadPinSummaryById } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ fullId: z.string(), packagesBasePath: z.string() }))
	.query(({ input }) => loadPinSummaryById(input.fullId, input.packagesBasePath))

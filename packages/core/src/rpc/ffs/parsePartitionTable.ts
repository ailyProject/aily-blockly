import { z } from 'zod'

import { parseFfsPartitionTable } from '../../ffs'
import { p } from '../trpc'

export default p
	.input(z.object({ bytes: z.array(z.number().int().min(0).max(255)) }))
	.query(({ input }) => parseFfsPartitionTable(Uint8Array.from(input.bytes)))

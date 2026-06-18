import { z } from 'zod'

import { isPlausibleFfsPartitionEntry } from '../../ffs'
import { p } from '../trpc'

export default p
	.input(z.object({ bytes: z.array(z.number().int().min(0).max(255)) }))
	.query(({ input }) => isPlausibleFfsPartitionEntry(Uint8Array.from(input.bytes)))

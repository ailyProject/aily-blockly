import { z } from 'zod'

import { summarizeFfsPartitions } from '../../ffs'
import { p } from '../trpc'
import { ffsPartitionSchema } from './schemas'

export default p
	.input(z.object({ partitions: z.array(ffsPartitionSchema) }))
	.query(({ input }) => summarizeFfsPartitions(input.partitions))

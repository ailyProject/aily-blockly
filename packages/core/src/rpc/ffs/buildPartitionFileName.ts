import { z } from 'zod'

import { buildFfsPartitionFileName } from '../../ffs'
import { p } from '../trpc'
import { ffsPartitionSchema } from './schemas'

export default p
	.input(z.object({ partition: ffsPartitionSchema }))
	.query(({ input }) => buildFfsPartitionFileName(input.partition))

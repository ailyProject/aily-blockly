import { z } from 'zod'

import { formatFfsImageFilesystem } from '../../ffs'
import { p } from '../trpc'
import { ffsPartitionSchema } from './schemas'

export default p
	.input(
		z.object({
			partition: ffsPartitionSchema,
			bytes: z.array(z.number().int().min(0).max(255))
		})
	)
	.query(({ input }) =>
		formatFfsImageFilesystem({
			partition: input.partition,
			image: Uint8Array.from(input.bytes)
		})
	)

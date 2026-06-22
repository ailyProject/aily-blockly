import { z } from 'zod'

import { readFfsImageFilePreview } from '../../ffs'
import { p } from '../trpc'
import { ffsPartitionSchema } from './schemas'

export default p
	.input(
		z.object({
			partition: ffsPartitionSchema,
			bytes: z.array(z.number().int().min(0).max(255)),
			path: z.string(),
			maxBytes: z
				.number()
				.int()
				.positive()
				.max(64 * 1024)
				.optional()
		})
	)
	.query(({ input }) =>
		readFfsImageFilePreview({
			partition: input.partition,
			image: Uint8Array.from(input.bytes),
			path: input.path,
			maxBytes: input.maxBytes
		})
	)

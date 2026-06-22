import { z } from 'zod'

import { deleteFfsImageEntry } from '../../ffs'
import { p } from '../trpc'
import { ffsPartitionSchema } from './schemas'

const ffsFileEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	type: z.enum(['file', 'dir']),
	size: z.number().int().nonnegative(),
	sizeText: z.string()
})

export default p
	.input(
		z.object({
			partition: ffsPartitionSchema,
			bytes: z.array(z.number().int().min(0).max(255)),
			entry: ffsFileEntrySchema
		})
	)
	.query(({ input }) =>
		deleteFfsImageEntry({
			partition: input.partition,
			image: Uint8Array.from(input.bytes),
			entry: input.entry
		})
	)

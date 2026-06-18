import { z } from 'zod'

import { buildFfsMountPlan } from '../../ffs'
import { p } from '../trpc'
import { ffsFilesystemTypeSchema } from './schemas'

export default p
	.input(
		z.object({
			type: ffsFilesystemTypeSchema,
			bytes: z.array(z.number().int().min(0).max(255))
		})
	)
	.query(({ input }) => buildFfsMountPlan(input.type, Uint8Array.from(input.bytes)))

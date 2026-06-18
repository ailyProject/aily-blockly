import { z } from 'zod'

import { getAvailableConnectionPinmapIds } from '../../connection'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			packagesBasePath: z.string(),
			status: z.enum(['available', 'needs_generation']).optional(),
			type: z.enum(['library', 'board', 'software']).optional(),
			protocol: z.string().optional()
		})
	)
	.query(({ input }) =>
		getAvailableConnectionPinmapIds(input.packagesBasePath, {
			status: input.status,
			type: input.type,
			protocol: input.protocol
		})
	)

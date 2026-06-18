import { z } from 'zod'

import { downloadWithHardwareProbeRs } from '../../hardware'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			firmwarePath: z.string(),
			chip: z.string().optional(),
			probe: z.string().optional(),
			protocol: z.string().optional(),
			speed: z.number().optional(),
			format: z.string().optional(),
			baseAddress: z.number().optional(),
			skipBytes: z.number().optional(),
			verify: z.boolean().optional()
		})
	)
	.mutation(({ input }) => downloadWithHardwareProbeRs(input))

import { z } from 'zod'

import { getHardwareModelAddress } from '../../hardware'
import { p } from '../trpc'

export default p
	.input(z.object({ xiaoType: z.union([z.literal(0), z.literal(1), z.literal(2)]) }))
	.query(({ input }) => getHardwareModelAddress(input.xiaoType))

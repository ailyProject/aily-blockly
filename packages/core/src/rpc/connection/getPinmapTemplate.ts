import { z } from 'zod'

import { getConnectionPinmapTemplate } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ protocol: z.string().optional() }))
	.query(({ input }) => getConnectionPinmapTemplate(input.protocol))

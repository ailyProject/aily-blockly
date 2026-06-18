import { z } from 'zod'

import { setQuickSendList } from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput, quickSendItemSchema } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			quickSendList: z.array(quickSendItemSchema)
		})
	)
	.query(({ input }) => setQuickSendList(normalizeAppConfigInput(input.config), input.quickSendList))

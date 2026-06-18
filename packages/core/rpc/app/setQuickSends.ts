import { z } from 'zod'

import { setQuickSendList } from '../../project'
import { p } from '../trpc'
import { appSchema, quickSendItemSchema } from './schemas'

export const setQuickSends = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			quickSendList: z.array(quickSendItemSchema)
		})
	)
	.query(({ input }) => setQuickSendList(input.config, input.quickSendList))

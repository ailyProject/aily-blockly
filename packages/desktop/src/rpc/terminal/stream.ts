import { observable } from '@trpc/server/observable'
import { z } from 'zod'

import { p } from '../../trpc'

export default p
	.input(
		z.object({
			sessionId: z.string()
		})
	)
	.subscription(({ ctx, input }) =>
		observable(subscriber => {
			const unsubscribe = ctx.terminalManager.subscribe(input.sessionId, event => {
				subscriber.next(event)
				if (event.type === 'exit') {
					subscriber.complete()
				}
			})

			return () => {
				unsubscribe()
			}
		})
	)

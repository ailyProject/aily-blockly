import { z } from 'zod'

import { p } from '../../trpc'

export default p
	.input(
		z.object({
			sessionId: z.string(),
			data: z.string()
		})
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.terminalManager.write(input.sessionId, input.data)
		return { ok: true }
	})

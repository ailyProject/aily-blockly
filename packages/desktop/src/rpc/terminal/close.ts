import { z } from 'zod'

import { p } from '../../trpc'

export default p
	.input(
		z.object({
			sessionId: z.string()
		})
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.terminalManager.close(input.sessionId)
		return { ok: true }
	})

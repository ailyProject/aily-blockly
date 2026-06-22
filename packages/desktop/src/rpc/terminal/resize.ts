import { z } from 'zod'

import { p } from '../../trpc'

export default p
	.input(
		z.object({
			sessionId: z.string(),
			cols: z.number().int().positive(),
			rows: z.number().int().positive()
		})
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.terminalManager.resize(input.sessionId, input.cols, input.rows)
		return { ok: true }
	})

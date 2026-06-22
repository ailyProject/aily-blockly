import { z } from 'zod'

import { p } from '../../trpc'

/**
 * 向当前 PTY 会话发送中断信号。
 */
export default p
	.input(
		z.object({
			sessionId: z.string()
		})
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.terminalManager.interrupt(input.sessionId)
		return { ok: true }
	})

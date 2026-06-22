import { z } from 'zod'

import { p } from '../../trpc'

/**
 * 在既有终端会话中执行一次命令并等待输出稳定。
 */
export default p
	.input(
		z.object({
			sessionId: z.string(),
			command: z.string(),
			idleTimeoutMs: z.number().int().positive().optional()
		})
	)
	.mutation(({ ctx, input }) => ctx.terminalManager.executeOnce(input.sessionId, input.command, input.idleTimeoutMs))

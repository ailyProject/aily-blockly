import { z } from 'zod'

import { p } from '../../trpc'

export default p
	.input(
		z.object({
			cwd: z.string().optional(),
			cols: z.number().int().positive().optional(),
			rows: z.number().int().positive().optional()
		})
	)
	.mutation(({ ctx, input }) => ctx.terminalManager.createSession(input))

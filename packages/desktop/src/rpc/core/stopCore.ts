import { p } from '../../trpc'

export const stopCore = p.mutation(async ({ ctx }) => {
	await ctx.coreService.stop()
	return ctx.coreService.getStatus()
})

import { p } from '../../trpc'

export default p.mutation(async ({ ctx }) => {
	await ctx.coreService.stop()
	return ctx.coreService.getStatus()
})

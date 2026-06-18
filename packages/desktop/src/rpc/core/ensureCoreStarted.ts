import { p } from '../../trpc'

export const ensureCoreStarted = p.query(async ({ ctx }) => {
	await ctx.coreService.start()
	return ctx.coreService.getStatus()
})

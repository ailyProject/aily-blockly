import { p } from '../../trpc'

export default p.query(async ({ ctx }) => {
	await ctx.coreService.start()
	return ctx.coreService.getStatus()
})

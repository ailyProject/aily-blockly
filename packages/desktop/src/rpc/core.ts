import { p, router } from '../trpc'

/**
 * desktop 暴露给 renderer 的 core 进程控制能力。
 */
export default router({
	getCoreStatus: p.query(async ({ ctx }) => ctx.coreService.getStatus()),
	ensureCoreStarted: p.query(async ({ ctx }) => {
		await ctx.coreService.start()
		return ctx.coreService.getStatus()
	}),
	stopCore: p.mutation(async ({ ctx }) => {
		await ctx.coreService.stop()
		return ctx.coreService.getStatus()
	})
})

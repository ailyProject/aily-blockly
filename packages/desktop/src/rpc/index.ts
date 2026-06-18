import { router } from '../trpc'
import core from './core/index'
import host from './host/index'

export const routers = router({
	core,
	host
})
export * from './types'

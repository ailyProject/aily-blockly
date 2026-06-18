import { router } from '../trpc'
import core from './core'

export const routers = router({
	core
})
export * from './types'

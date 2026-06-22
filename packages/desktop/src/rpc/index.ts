import { router } from '../trpc'
import { default as ble } from './ble/index'
import { default as core } from './core/index'
import { default as host } from './host/index'
import { default as terminal } from './terminal/index'

export default router({
	ble,
	core,
	host,
	terminal
})
export * from './types'

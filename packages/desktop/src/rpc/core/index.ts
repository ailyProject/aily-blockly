import { router } from '../../trpc'
import { default as ensureCoreStarted } from './ensureCoreStarted'
import { default as getCoreStatus } from './getCoreStatus'
import { default as stopCore } from './stopCore'

export default router({
	getCoreStatus,
	ensureCoreStarted,
	stopCore
})

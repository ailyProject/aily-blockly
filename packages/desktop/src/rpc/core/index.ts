import { router } from '../../trpc'
import { default as ensureCoreStarted } from './ensureCoreStarted'
import { default as getCoreStatus } from './getCoreStatus'

export default router({
	getCoreStatus,
	ensureCoreStarted
})

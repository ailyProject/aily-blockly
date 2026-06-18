import { router } from '../../trpc'
import { ensureCoreStarted } from './ensureCoreStarted'
import { getCoreStatus } from './getCoreStatus'
import { stopCore } from './stopCore'

export default router({
	getCoreStatus,
	ensureCoreStarted,
	stopCore
})

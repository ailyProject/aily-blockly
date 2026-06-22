import { router } from '../../trpc'
import { default as consumePendingProjectOpen } from './consumePendingProjectOpen'
import { default as focusProcess } from './focusProcess'
import { default as getRuntimeInfo } from './getRuntimeInfo'
import { default as selectDirectory } from './selectDirectory'
import { default as selectProjectPath } from './selectProjectPath'

export default router({
	consumePendingProjectOpen,
	focusProcess,
	getRuntimeInfo,
	selectDirectory,
	selectProjectPath
})

import { router } from '../../trpc'
import { default as closeWindow } from './closeWindow'
import { default as consumePendingProjectOpen } from './consumePendingProjectOpen'
import { default as focusProcess } from './focusProcess'
import { default as getRuntimeInfo } from './getRuntimeInfo'
import { default as getWindowState } from './getWindowState'
import { default as minimizeWindow } from './minimizeWindow'
import { default as selectDirectory } from './selectDirectory'
import { default as selectProjectPath } from './selectProjectPath'
import { default as toggleMaximizeWindow } from './toggleMaximizeWindow'

export default router({
	closeWindow,
	consumePendingProjectOpen,
	focusProcess,
	getRuntimeInfo,
	getWindowState,
	minimizeWindow,
	selectDirectory,
	selectProjectPath,
	toggleMaximizeWindow
})

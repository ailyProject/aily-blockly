import { app } from 'electron'

import { p } from '../../trpc'

import type { DesktopHostRuntimeInfo } from '../types'

const resolvePlatform = (): 'windows' | 'macos' | 'linux' =>
	process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

export default p.query(
	async (): Promise<DesktopHostRuntimeInfo> => ({
		available: true,
		appDataPath: app.getPath('userData'),
		platform: resolvePlatform(),
		childPath: process.env['AILY_CHILD_PATH']
	})
)

import path from 'node:path'
import { app } from 'electron'

import { resolveLegacyDesktopAppDataPath } from '../../app/appdata'
import { p } from '../../trpc'

import type { DesktopHostRuntimeInfo } from '../types'

const resolvePlatform = (): 'windows' | 'macos' | 'linux' =>
	process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

export default p.query(
	async (): Promise<DesktopHostRuntimeInfo> => ({
		available: true,
		pid: process.pid,
		appDataPath:
			process.env['AILY_APPDATA_PATH'] ||
			(process.platform === 'darwin' ? resolveLegacyDesktopAppDataPath() : app.getPath('userData')),
		documentsPath: app.getPath('documents'),
		platform: resolvePlatform(),
		pathSeparator: path.sep,
		cwd: process.cwd(),
		childPath: process.env['AILY_CHILD_PATH']
	})
)

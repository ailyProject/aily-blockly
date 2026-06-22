import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeDesktopStartupLog } from './log'

export const resolveLegacyDesktopAppDataPath = () => path.join(os.homedir(), 'Library', 'aily-project')

/**
 * 在 desktop 启动时确保 legacy appdata 目录可用，并写入环境变量。
 */
export const ensureLegacyDesktopAppDataPath = () => {
	if (process.platform !== 'darwin') return

	const targetPath = resolveLegacyDesktopAppDataPath()
	try {
		fs.mkdirSync(targetPath, { recursive: true })
		process.env['AILY_APPDATA_PATH'] = targetPath
		writeDesktopStartupLog(`[desktop-app] ensured-legacy-appdata ${targetPath}`)
	} catch (error) {
		writeDesktopStartupLog(
			`[desktop-app] ensured-legacy-appdata-failed ${error instanceof Error ? error.message : String(error)}`
		)
	}
}

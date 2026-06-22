import { app } from 'electron'

import { queueDesktopPendingProjectOpenPath } from './state'

const isProjectOpenCandidate = (value: string) => {
	const normalized = String(value || '').trim()
	if (!normalized) return false
	if (normalized.startsWith('--')) return false
	if (normalized.startsWith('electron')) return false
	if (normalized.startsWith('file://')) return true
	return normalized.includes('/') || normalized.includes('\\')
}

const resolveDesktopProjectOpenArg = (argv: Array<string>) => {
	const candidates = argv.filter(isProjectOpenCandidate)
	return candidates[candidates.length - 1] || ''
}

/**
 * 注册最小的桌面项目打开事件。
 * @param app - Electron App 实例
 */
export const registerDesktopProjectOpenEvents = (inputApp: typeof app) => {
	const initialProjectPath = resolveDesktopProjectOpenArg(process.argv)
	if (initialProjectPath) {
		queueDesktopPendingProjectOpenPath(initialProjectPath)
	}

	inputApp.on('open-file', (event, filePath) => {
		event.preventDefault()
		queueDesktopPendingProjectOpenPath(filePath)
	})

	inputApp.on('second-instance', (_event, argv) => {
		const projectPath = resolveDesktopProjectOpenArg(argv)
		if (projectPath) {
			queueDesktopPendingProjectOpenPath(projectPath)
		}
	})
}

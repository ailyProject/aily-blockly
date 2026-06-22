import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { renderHardwareUploadPatternTemplate } from './parse'

/**
 * 从 preprocess.json 中解析 esp32 上传参数模板。
 * @param projectPath - 当前项目目录
 */
export const resolveHardwareUploadParamFromPreprocess = (projectPath: string) => {
	const preprocessPath = path.join(projectPath, '.temp', 'preprocess.json')
	if (!existsSync(preprocessPath)) return null

	const preprocess = JSON.parse(readFileSync(preprocessPath, 'utf8')) as {
		arduinoConfig?: { board?: Record<string, string>; platform?: Record<string, string> }
	}

	const board = preprocess.arduinoConfig?.board ?? {}
	const platformConfig = preprocess.arduinoConfig?.platform ?? {}
	const uploadPattern = String(platformConfig['tools.esptool.upload.pattern'] || '').trim()
	if (!uploadPattern) return null

	const resolver = (key: string) => {
		if (key in board) return String(board[key] || '')
		if (key in platformConfig) return String(platformConfig[key] || '')
		return undefined
	}

	return renderHardwareUploadPatternTemplate(uploadPattern, resolver)
}

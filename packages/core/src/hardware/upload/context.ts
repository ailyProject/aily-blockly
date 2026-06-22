import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getProjectConfig, getSelectedBoardPackage } from '../../project'
import { resolveHardwareUploadBuildPath } from './buildPath'
import { resolveHardwareUploadParamFromPreprocess } from './command'

import type { ProjectPackageJson } from '../../project'
import type { HardwareRunUploadInput, HardwareUploadContext } from './types'

type HardwareUploadBoardJson = {
	/** 开发板 core 定义。 */
	core?: string
	/** legacy 上传参数模板。 */
	uploadParam?: string
}

type HardwareUploadBoardPackageJson = {
	/** 开发板依赖声明。 */
	boardDependencies?: Record<string, string>
}

const readJsonFile = <T>(filePath: string) => JSON.parse(readFileSync(filePath, 'utf8')) as T

const resolveHardwareDebuggerPnum = (projectConfig: Record<string, unknown>) => {
	const pnum = projectConfig['pnum']
	return typeof pnum === 'string' && pnum.trim() ? pnum.trim() : undefined
}

const resolveSdkPath = (appDataPath: string, boardDependencies: Record<string, string>) => {
	const sdkEntry = Object.entries(boardDependencies).find(([name]) => name.startsWith('@aily-project/sdk-'))
	if (!sdkEntry) return ''

	return path.join(appDataPath, 'sdk', `${sdkEntry[0].replace(/^@aily-project\/sdk-/, '')}_${sdkEntry[1]}`)
}

const resolveToolDependencies = (boardDependencies: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(boardDependencies)
			.filter(([name]) => name.startsWith('@aily-project/tool-') || name.startsWith('tool-'))
			.map(([name, version]) => [name.replace(/^@aily-project\/tool-/, '').replace(/^tool-/, ''), version])
	)

/**
 * 解析上传执行所需的工程、板卡和工具上下文。
 * @param input - 上传输入
 */
export const resolveHardwareUploadContext = (input: HardwareRunUploadInput): HardwareUploadContext => {
	const packageJson = readJsonFile<ProjectPackageJson>(path.join(input.projectPath, 'package.json'))
	const boardPackageName = getSelectedBoardPackage(packageJson)
	if (!boardPackageName) throw new Error('当前项目未声明开发板依赖')

	const boardRoot = path.join(input.projectPath, 'node_modules', boardPackageName)
	const boardJson = readJsonFile<HardwareUploadBoardJson>(path.join(boardRoot, 'board.json'))
	const boardPackageJson = readJsonFile<HardwareUploadBoardPackageJson>(path.join(boardRoot, 'package.json'))
	const boardDependencies = boardPackageJson.boardDependencies ?? {}
	const coreName = String(boardJson.core || 'arduino').split(':')[0] || 'arduino'
	const projectConfig = getProjectConfig(packageJson)
	const fallbackUploadParam = String(boardJson.uploadParam || '').trim()
	const preprocessUploadParam = coreName.toLowerCase().includes('esp32')
		? resolveHardwareUploadParamFromPreprocess(input.projectPath)
		: null
	const uploadParam = String(preprocessUploadParam || fallbackUploadParam).trim()
	if (!uploadParam) throw new Error('未找到开发板上传参数')

	return {
		projectPath: input.projectPath,
		buildPath: resolveHardwareUploadBuildPath(path.join(input.projectPath, '.temp', 'sketch', 'sketch.ino')),
		toolsPath: path.join(input.appDataPath, 'tools'),
		sdkPath: resolveSdkPath(input.appDataPath, boardDependencies),
		boardPackageName,
		coreName,
		baudRate: String(projectConfig['UploadSpeed'] ?? (coreName === 'arduino' ? '115200' : '921600')),
		debuggerPnum: resolveHardwareDebuggerPnum(projectConfig),
		uploadParam,
		fallbackUploadParam,
		uploadParamSource: preprocessUploadParam ? 'preprocess' : 'fallback',
		toolDependencies: resolveToolDependencies(boardDependencies)
	}
}

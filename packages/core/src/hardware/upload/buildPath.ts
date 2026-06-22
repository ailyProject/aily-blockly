import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const resolveAilyBuilderBuildRoot = () =>
	process.platform === 'win32'
		? path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'project')
		: process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'aily-builder', 'project')
			: path.join(os.homedir(), '.cache', 'aily-builder', 'project')

const collectFilesRecursively = (directoryPath: string): Array<string> => {
	if (!existsSync(directoryPath)) return []

	const results: Array<string> = []
	for (const entryName of readdirSync(directoryPath)) {
		const entryPath = path.join(directoryPath, entryName)
		const stat = statSync(entryPath)
		if (stat.isDirectory()) {
			results.push(...collectFilesRecursively(entryPath))
			continue
		}

		results.push(entryPath)
	}

	return results
}

/**
 * 解析当前 sketch 对应的 aily-builder 构建输出目录。
 * @param sketchFilePath - .temp/sketch/sketch.ino 路径
 */
export const resolveHardwareUploadBuildPath = (sketchFilePath: string) => {
	const sketchName = path.basename(sketchFilePath, '.ino')
	const digest = createHash('md5').update(path.resolve(sketchFilePath)).digest('hex').slice(0, 8)
	return path.join(resolveAilyBuilderBuildRoot(), `${sketchName}_${digest}`)
}

/**
 * 递归查找匹配指定模式的构建产物。
 * @param basePath - 构建目录
 * @param pattern - 文件名或通配模式
 * @param version - 路径版本偏好
 */
export const findHardwareUploadArtifact = (basePath: string, pattern: string, version = '') => {
	const files = collectFilesRecursively(basePath)
	const matches = pattern.includes('*')
		? files.filter(filePath =>
				new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(path.basename(filePath))
			)
		: files.filter(filePath => path.basename(filePath) === pattern)

	if (!version || matches.length <= 1) return matches[0] || ''
	return matches.find(filePath => filePath.includes(version)) || matches[0] || ''
}

/**
 * 递归收集构建目录下的全部文件路径。
 * @param basePath - 要扫描的根目录
 */
export const listHardwareUploadArtifacts = (basePath: string) => collectFilesRecursively(basePath)

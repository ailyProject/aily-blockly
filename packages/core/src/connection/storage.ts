import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { resolveConnectionGraphPaths } from './paths'

import type { ConnectionGraphData } from './types'

/**
 * 读取已保存的连线图数据。
 * @param {string} projectPath - 项目根路径
 * @returns {ConnectionGraphData | null}
 */
export const readConnectionGraph = (projectPath: string): ConnectionGraphData | null => {
	try {
		const { jsonPath } = resolveConnectionGraphPaths(projectPath)
		if (!existsSync(jsonPath)) return null
		return JSON.parse(readFileSync(jsonPath, 'utf8')) as ConnectionGraphData
	} catch {
		return null
	}
}

/**
 * 检查项目是否存在连线图 JSON。
 * @param {string} projectPath - 项目根路径
 * @returns {boolean}
 */
export const hasConnectionGraph = (projectPath: string) => existsSync(resolveConnectionGraphPaths(projectPath).jsonPath)

/**
 * 保存连线图 JSON。
 * @param {ConnectionGraphData} data - 连线图数据
 * @param {string} projectPath - 项目根路径
 * @returns {{success: boolean, filePath: string, error?: string}}
 */
export const saveConnectionGraph = (data: ConnectionGraphData, projectPath: string) => {
	const { jsonPath } = resolveConnectionGraphPaths(projectPath)

	try {
		writeFileSync(jsonPath, JSON.stringify(data, null, 2))
		return { success: true, filePath: jsonPath }
	} catch (error) {
		return { success: false, filePath: jsonPath, error: (error as Error).message }
	}
}

/**
 * 保存 AWS 源文件。
 * @param {string} awsContent - AWS 文本内容
 * @param {string} projectPath - 项目根路径
 * @returns {{success: boolean, filePath: string, error?: string}}
 */
export const saveConnectionAws = (awsContent: string, projectPath: string) => {
	const { awsPath } = resolveConnectionGraphPaths(projectPath)

	try {
		writeFileSync(awsPath, awsContent)
		return { success: true, filePath: awsPath }
	} catch (error) {
		return { success: false, filePath: awsPath, error: (error as Error).message }
	}
}

/**
 * 读取 AWS 源文件。
 * @param {string} projectPath - 项目根路径
 * @returns {string | null}
 */
export const readConnectionAws = (projectPath: string) => {
	try {
		const { awsPath } = resolveConnectionGraphPaths(projectPath)
		return existsSync(awsPath) ? readFileSync(awsPath, 'utf8') : null
	} catch {
		return null
	}
}

/**
 * 检查项目是否存在 AWS 源文件。
 * @param {string} projectPath - 项目根路径
 * @returns {boolean}
 */
export const hasConnectionAws = (projectPath: string) => existsSync(resolveConnectionGraphPaths(projectPath).awsPath)

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { addRecentlyProject, getRecentProjects, removeRecentlyProject } from './recent'

import type { AilyAppConfig, RecentlyProjectEntry } from 'shared'
import type { ProjectConfigFileInput, ProjectConfigFileWriteInput } from './types'

const resolveProjectConfigFilePath = (appDataPath: string) => path.join(appDataPath, 'config.json')

/**
 * 从 appDataPath 读取当前配置文件。
 * @param input - 配置文件读取输入
 */
export const readProjectConfigFile = (input: ProjectConfigFileInput): AilyAppConfig | undefined => {
	const filePath = resolveProjectConfigFilePath(input.appDataPath)
	if (!existsSync(filePath)) return undefined

	try {
		return JSON.parse(readFileSync(filePath, 'utf8')) as AilyAppConfig
	} catch {
		return undefined
	}
}

/**
 * 把完整配置对象写回到 appDataPath/config.json。
 * @param input - 配置文件写回输入
 */
export const writeProjectConfigFile = async (input: ProjectConfigFileWriteInput) => {
	await mkdir(input.appDataPath, { recursive: true })
	const filePath = resolveProjectConfigFilePath(input.appDataPath)
	await writeFile(filePath, JSON.stringify(input.config, null, 2) + '\n', 'utf8')
	return filePath
}

/**
 * 从配置文件中读取最近项目列表。
 * @param input - 配置文件读取输入
 */
export const readStoredRecentProjects = (input: ProjectConfigFileInput) =>
	getRecentProjects(readProjectConfigFile(input))

/**
 * 把单个最近项目条目写回配置文件。
 * @param input - 配置文件路径与最近项目
 */
export const addStoredRecentProject = async (input: ProjectConfigFileInput & { project: RecentlyProjectEntry }) => {
	const currentConfig = readProjectConfigFile(input) ?? {}
	const nextConfig: AilyAppConfig = {
		...currentConfig,
		recentlyProjects: addRecentlyProject(getRecentProjects(currentConfig), input.project)
	}
	await writeProjectConfigFile({
		appDataPath: input.appDataPath,
		config: nextConfig
	})
	return nextConfig.recentlyProjects
}

/**
 * 从配置文件中移除指定最近项目条目。
 * @param input - 配置文件路径与要移除的项目路径
 */
export const removeStoredRecentProject = async (input: ProjectConfigFileInput & { projectPath: string }) => {
	const currentConfig = readProjectConfigFile(input) ?? {}
	const nextConfig: AilyAppConfig = {
		...currentConfig,
		recentlyProjects: removeRecentlyProject(getRecentProjects(currentConfig), input.projectPath)
	}
	await writeProjectConfigFile({
		appDataPath: input.appDataPath,
		config: nextConfig
	})
	return nextConfig.recentlyProjects
}

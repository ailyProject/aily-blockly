import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { isBlocklyLibraryPackageName } from '../packageRules'

import type { ProjectPackageJson } from '../types'

/**
 * 解析当前平台应使用的 pnpm 可执行文件。
 */
export const getProjectPackageManagerCommand = () => (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')

/**
 * 读取项目 package.json 路径。
 * @param projectPath - 当前项目目录
 */
export const getProjectPackageJsonPath = (projectPath: string) => path.join(projectPath, 'package.json')

/**
 * 断言当前项目目录存在 package.json。
 * @param projectPath - 当前项目目录
 */
export const assertProjectPackageJsonExists = (projectPath: string) => {
	const packageJsonPath = getProjectPackageJsonPath(projectPath)
	if (!existsSync(packageJsonPath)) {
		throw new Error(`Project package.json is missing: ${projectPath}`)
	}
	return packageJsonPath
}

/**
 * 读取项目 package.json 文本内容。
 * @param projectPath - 当前项目目录
 */
export const readProjectPackageJsonText = async (projectPath: string) =>
	readFile(assertProjectPackageJsonExists(projectPath), 'utf8')

/**
 * 读取项目 package.json 数据。
 * @param projectPath - 当前项目目录
 */
export const readProjectPackageJsonData = async (projectPath: string) =>
	JSON.parse(await readProjectPackageJsonText(projectPath)) as ProjectPackageJson

/**
 * 断言目标库包名符合 Blockly 库命名规则。
 * @param packageName - 目标库包名
 */
export const assertBlocklyLibraryPackageName = (packageName: string) => {
	if (!isBlocklyLibraryPackageName(packageName)) {
		throw new Error(`Unsupported Blockly library package: ${packageName}`)
	}
}

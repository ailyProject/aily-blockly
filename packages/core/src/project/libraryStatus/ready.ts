import { existsSync } from 'node:fs'
import path from 'node:path'

import { isBlocklyLibraryPackageName } from '../packageRules'

const BLOCKLY_LIBRARY_REQUIRED_FILES = ['package.json', 'block.json', 'toolbox.json', 'generator.js']

const getNodeModulePackagePath = (projectPath: string, packageName: string) =>
	path.join(projectPath, 'node_modules', ...packageName.split('/'))

/**
 * 判断某个 Blockly 库包在当前项目中是否已具备关键文件。
 * @param projectPath - 当前项目目录
 * @param packageName - 库包名
 */
export const isProjectBlocklyLibraryPackageReady = (projectPath: string, packageName: string) => {
	if (!isBlocklyLibraryPackageName(packageName)) return false
	const packagePath = getNodeModulePackagePath(projectPath, packageName)
	return BLOCKLY_LIBRARY_REQUIRED_FILES.every(fileName => existsSync(path.join(packagePath, fileName)))
}

/**
 * 过滤出当前项目中已就绪的 Blockly 库包名。
 * @param projectPath - 当前项目目录
 * @param packageNames - 待检查包名
 */
export const getReadyProjectBlocklyLibraryPackages = (projectPath: string, packageNames: Iterable<string>) =>
	[...packageNames].filter(packageName => isProjectBlocklyLibraryPackageReady(projectPath, packageName))

import { getDeclaredDependencies } from './packageJson'

import type { ProjectPackageJson } from './types'

/**
 * 判断包名是否为 Aily 开发板包
 * @param packageName - 包名
 */
export const isBoardPackageName = (packageName: string) => /^@aily-project\/board-[a-zA-Z0-9._-]+$/.test(packageName)

/**
 * 判断包名是否为 Aily Blockly 库包
 * @param packageName - 包名
 */
export const isBlocklyLibraryPackageName = (packageName: string) =>
	/^@aily-project\/lib-[a-zA-Z0-9._-]+$/.test(packageName)

/**
 * 按谓词筛选已声明依赖
 * @param packageJson - 项目 package.json
 * @param predicate - 包名筛选条件
 */
export const getDeclaredDependenciesByPredicate = (
	packageJson: ProjectPackageJson | null | undefined,
	predicate: (packageName: string) => boolean
) => {
	const dependencies = getDeclaredDependencies(packageJson ?? {}).all
	const result = new Map<string, string>()

	for (const [name, version] of Object.entries(dependencies)) {
		if (predicate(name)) {
			result.set(name, String(version ?? ''))
		}
	}

	return result
}

/**
 * 提取已声明的开发板包依赖
 * @param packageJson - 项目 package.json
 */
export const getDeclaredBoardDependencies = (packageJson: ProjectPackageJson | null | undefined) =>
	getDeclaredDependenciesByPredicate(packageJson, isBoardPackageName)

/**
 * 提取已声明的 Blockly 库依赖
 * @param packageJson - 项目 package.json
 */
export const getDeclaredBlocklyLibraryDependencies = (packageJson: ProjectPackageJson | null | undefined) =>
	getDeclaredDependenciesByPredicate(packageJson, isBlocklyLibraryPackageName)

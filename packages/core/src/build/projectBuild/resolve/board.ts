import { existsSync } from 'node:fs'
import path from 'node:path'

import { getSelectedBoardPackage } from '../../../project'
import { readJsonFile } from '../helpers'
import { COMPILER_PACKAGE_PREFIX, SDK_PACKAGE_PREFIX, TOOL_PACKAGE_PREFIX } from '../shared'

import type { ProjectPackageJson } from '../../../project'
import type { ProjectBuildBoardDefinition, ProjectBuildBoardPackageJson } from '../helpers'
import type { ProjectBuildInput } from '../types'

/**
 * 解析项目当前选中的开发板上下文。
 * @param input - 项目构建输入
 */
export const resolveProjectBuildBoardContext = (input: ProjectBuildInput) => {
	const packageJsonPath = path.join(input.projectPath, 'package.json')
	if (!existsSync(packageJsonPath)) {
		throw new Error(`未找到项目 package.json: ${packageJsonPath}`)
	}

	const projectPackageJson = readJsonFile<ProjectPackageJson>(packageJsonPath)
	const boardPackageName = getSelectedBoardPackage(projectPackageJson)
	if (!boardPackageName) {
		throw new Error('当前项目未声明开发板依赖')
	}

	const boardPackagePath = path.join(input.projectPath, 'node_modules', boardPackageName)
	const boardJsonPath = path.join(boardPackagePath, 'board.json')
	const boardPackageJsonPath = path.join(boardPackagePath, 'package.json')
	if (!existsSync(boardJsonPath) || !existsSync(boardPackageJsonPath)) {
		throw new Error(`未找到开发板定义文件: ${boardPackageName}`)
	}

	const boardDefinition = readJsonFile<ProjectBuildBoardDefinition>(boardJsonPath)
	const boardPackageJson = readJsonFile<ProjectBuildBoardPackageJson>(boardPackageJsonPath)
	if (!boardDefinition.compilerParam) {
		throw new Error(`开发板 ${boardPackageName} 缺少 compilerParam`)
	}
	const compilerParam = boardDefinition.compilerParam

	const toolVersions: Array<string> = []
	let compilerPath = ''
	let sdkPath = ''

	for (const [dependencyName, dependencyVersion] of Object.entries(boardPackageJson.boardDependencies ?? {})) {
		if (dependencyName.startsWith(COMPILER_PACKAGE_PREFIX)) {
			const compilerVersionName = `${dependencyName.slice(COMPILER_PACKAGE_PREFIX.length)}@${dependencyVersion}`
			toolVersions.push(compilerVersionName)
			compilerPath = path.join(input.appDataPath, 'compiler', compilerVersionName)
			continue
		}

		if (dependencyName.startsWith(SDK_PACKAGE_PREFIX)) {
			sdkPath = path.join(
				input.appDataPath,
				'sdk',
				`${dependencyName.slice(SDK_PACKAGE_PREFIX.length)}_${dependencyVersion}`
			)
			continue
		}

		if (dependencyName.startsWith(TOOL_PACKAGE_PREFIX)) {
			const rawToolName = dependencyName.slice(TOOL_PACKAGE_PREFIX.length)
			const toolName = rawToolName.startsWith('idf_') ? 'esp32-arduino-libs' : rawToolName
			toolVersions.push(`${toolName}@${dependencyVersion}`)
		}
	}

	if (!compilerPath || !sdkPath) {
		throw new Error(`开发板 ${boardPackageName} 缺少编译器或 SDK 依赖`)
	}

	return {
		projectPackageJson,
		boardPackageName,
		boardDefinition,
		compilerParam,
		toolVersions,
		compilerPath,
		sdkPath
	}
}

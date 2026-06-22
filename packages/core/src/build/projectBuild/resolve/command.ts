import path from 'node:path'

import { LIBRARY_PACKAGE_PREFIX } from '../shared'

import type { ProjectPackageJson } from '../../../project'
import type { ProjectBuildInput, ProjectBuildLibraryBinding, ProjectBuildPlan } from '../types'

/**
 * 解析项目构建阶段会镜像的 Blockly 库列表。
 * @param input - 项目构建输入
 * @param projectPackageJson - 项目 package.json
 * @param getDeclaredBlocklyLibraryDependencies - 依赖解析函数
 */
export const resolveProjectBuildLibraries = (
	input: ProjectBuildInput,
	projectPackageJson: ProjectPackageJson,
	getDeclaredBlocklyLibraryDependencies: (packageJson: ProjectPackageJson) => Map<string, string>
): Array<ProjectBuildLibraryBinding> =>
	Array.from(getDeclaredBlocklyLibraryDependencies(projectPackageJson).entries())
		.filter(
			([packageName]) =>
				packageName.startsWith(LIBRARY_PACKAGE_PREFIX) && !packageName.startsWith(`${LIBRARY_PACKAGE_PREFIX}core`)
		)
		.map(([packageName]) => {
			const dirName = packageName.replace(/^@aily-project\//, '')
			return {
				packageName,
				sourcePath: path.join(input.projectPath, 'node_modules', packageName),
				targetPath: path.join(input.projectPath, '.temp', 'libraries', dirName)
			}
		})

/**
 * 解析构建期路径集合。
 * @param input - 项目构建输入
 * @param compilerPath - 编译器目录
 * @param sdkPath - SDK 目录
 */
export const resolveProjectBuildPaths = (input: ProjectBuildInput, compilerPath: string, sdkPath: string) => ({
	projectPath: input.projectPath,
	ailyBuilderPath: path.join(input.childPath, 'aily-builder'),
	tempPath: path.join(input.projectPath, '.temp'),
	sketchPath: path.join(input.projectPath, '.temp', 'sketch'),
	sketchFilePath: path.join(input.projectPath, '.temp', 'sketch', 'sketch.ino'),
	preprocessResultPath: path.join(input.projectPath, '.temp', 'preprocess.json'),
	librariesPath: path.join(input.projectPath, '.temp', 'libraries'),
	compilerRootPath: path.join(input.appDataPath, 'compiler'),
	sdkRootPath: path.join(input.appDataPath, 'sdk'),
	toolsRootPath: path.join(input.appDataPath, 'tools'),
	compilerPath,
	sdkPath
})

/**
 * 构造 preprocess 命令。
 * @param input - 命令上下文
 */
export const createProjectPreprocessCommand = (input: {
	builderEntryPath: string
	boardType: string
	boardOptions: Array<string>
	macros: Array<string>
	toolVersions: Array<string>
	paths: ProjectBuildPlan['paths']
	projectPath: string
}) => ({
	label: 'preprocess',
	executable: process.execPath,
	args: [
		input.builderEntryPath,
		'preprocess',
		input.paths.sketchFilePath,
		'--board',
		input.boardType,
		'--libraries-path',
		input.paths.librariesPath,
		'--sdk-path',
		input.paths.sdkPath,
		'--tools-path',
		input.paths.toolsRootPath,
		'--tool-versions',
		input.toolVersions.join(','),
		'--save-result',
		input.paths.preprocessResultPath,
		...input.boardOptions.flatMap(option => ['--board-options', option]),
		...input.macros.flatMap(macro => ['--build-macros', macro])
	],
	cwd: input.projectPath
})

/**
 * 构造 compile 命令。
 * @param input - 命令上下文
 */
export const createProjectCompileCommand = (input: {
	builderEntryPath: string
	boardType: string
	paths: ProjectBuildPlan['paths']
	projectPath: string
}) => ({
	label: 'compile',
	executable: process.execPath,
	args: [
		input.builderEntryPath,
		'compile',
		input.paths.sketchFilePath,
		'--board',
		input.boardType,
		'--preprocess-result',
		input.paths.preprocessResultPath
	],
	cwd: input.projectPath
})

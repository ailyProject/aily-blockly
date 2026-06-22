import { readFileSync } from 'node:fs'

import type { ProjectPackageJson } from '../../project'

/**
 * 开发板包 package.json 的最小形状。
 */
export interface ProjectBuildBoardPackageJson {
	/** 开发板依赖声明。 */
	boardDependencies?: Record<string, string>
}

/**
 * board.json 的最小形状。
 */
export interface ProjectBuildBoardDefinition {
	/** 上传或编译所属 core。 */
	core?: string
	/** legacy 编译参数模板。 */
	compilerParam?: string
}

/**
 * 读取 JSON 文件并按调用侧约定断言类型。
 * @param filePath - JSON 文件路径
 */
export const readJsonFile = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, 'utf8')) as T

/**
 * 归一化项目宏定义。
 * @param value - package.json 中的 MACROS 字段
 */
export const normalizeProjectBuildMacros = (value: ProjectPackageJson['MACROS']) =>
	(value ?? [])
		.flatMap(item => (Array.isArray(item) ? item : [item]))
		.map(item => String(item ?? '').trim())
		.filter(item => item.length > 0)

/**
 * 把 projectConfig 转成 builder 可接受的 board-options 列表。
 * @param value - 项目配置对象
 */
export const normalizeProjectBuildBoardOptions = (value: Record<string, unknown>) =>
	Object.entries(value)
		.filter(
			([, optionValue]) => optionValue !== null && optionValue !== undefined && String(optionValue).trim().length > 0
		)
		.map(([optionName, optionValue]) => `${optionName}=${String(optionValue).trim()}`)

/**
 * 从 compilerParam 中提取 board 类型。
 * @param compilerParam - board.json 中的 compilerParam
 */
export const extractProjectBuildBoardType = (compilerParam: string) => {
	const args = compilerParam.split(/\s+/).filter(Boolean)
	for (let index = 0; index < args.length; index += 1) {
		if ((args[index] === '-b' || args[index] === '--board') && args[index + 1]) {
			return args[index + 1]
		}
	}

	throw new Error('未找到开发板 boardType，请检查 board.json 的 compilerParam')
}

import type { DeclaredDependencies, ProjectPackageJson } from './types'

const normalizeDependencyMap = (value: unknown): Record<string, string> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

	return Object.fromEntries(
		Object.entries(value)
			.filter((entry): entry is [string, unknown] => typeof entry[0] === 'string')
			.map(([name, spec]) => [name, typeof spec === 'string' ? spec : String(spec ?? '')])
			.filter(([, spec]) => spec.length > 0)
	)
}

/**
 * 统一提取 package.json 中三类依赖，并生成一个合并后的依赖视图
 * @param packageJson - 项目 package.json 数据
 */
export const getDeclaredDependencies = (packageJson: ProjectPackageJson): DeclaredDependencies => {
	const dependencies = normalizeDependencyMap(packageJson.dependencies)
	const devDependencies = normalizeDependencyMap(packageJson.devDependencies)
	const optionalDependencies = normalizeDependencyMap(packageJson.optionalDependencies)

	return {
		dependencies,
		devDependencies,
		optionalDependencies,
		all: {
			...dependencies,
			...devDependencies,
			...optionalDependencies
		}
	}
}

/**
 * 返回当前项目声明但缺失的依赖包名
 * @param declared - 已声明依赖集合
 * @param installedPackageNames - 当前已安装包名列表
 */
export const getUndeclaredDependencyNames = (declared: DeclaredDependencies, installedPackageNames: Array<string>) =>
	installedPackageNames.filter(packageName => !(packageName in declared.all))

/**
 * 合并 package.json 片段并保留未覆盖字段
 * @param current - 当前 package.json
 * @param next - 待合并的新数据
 */
export const mergeProjectPackageJson = (
	current: ProjectPackageJson | null | undefined,
	next: ProjectPackageJson
): ProjectPackageJson => ({
	...(current ?? {}),
	...next
})

/**
 * 判断两份 package.json 内容是否等价
 * @param left - 左侧 package.json
 * @param right - 右侧 package.json
 */
export const isSameProjectPackageJson = (
	left: ProjectPackageJson | null | undefined,
	right: ProjectPackageJson | null | undefined
) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/**
 * 读取项目配置块
 * @param packageJson - 项目 package.json
 */
export const getProjectConfig = (packageJson: ProjectPackageJson | null | undefined) =>
	packageJson?.projectConfig && typeof packageJson.projectConfig === 'object' ? packageJson.projectConfig : {}

/**
 * 提取当前项目选择的开发板包名称
 * @param packageJson - 项目 package.json
 */
export const getSelectedBoardPackage = (packageJson: ProjectPackageJson | null | undefined) => {
	const dependencies = getDeclaredDependencies(packageJson ?? {}).dependencies
	return Object.keys(dependencies).find(dependency => dependency.startsWith('@aily-project/board-')) ?? null
}

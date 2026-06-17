import type { ProjectPackageJson } from './types'

const normalizeMacros = (value: ProjectPackageJson['MACROS']) =>
	(value ?? [])
		.map(item => {
			if (Array.isArray(item)) return String(item[0] ?? '').trim()
			return String(item ?? '').trim()
		})
		.filter(item => item.length > 0)

/**
 * 添加或覆盖同名宏定义，保持宏列表规范化后再返回新的 package.json
 * @param {ProjectPackageJson} packageJson - 项目 package.json
 * @param {string} macro - 宏定义字符串
 * @returns {ProjectPackageJson}
 */
export const upsertMacro = (packageJson: ProjectPackageJson, macro: string): ProjectPackageJson => {
	const normalized = normalizeMacros(packageJson.MACROS)
	const macroName = macro.split('=')[0]
	const existingIndex = normalized.findIndex(item => item.split('=')[0] === macroName)

	if (existingIndex >= 0) {
		normalized[existingIndex] = macro
	} else {
		normalized.push(macro)
	}

	return {
		...packageJson,
		MACROS: normalized.map(item => [item])
	}
}

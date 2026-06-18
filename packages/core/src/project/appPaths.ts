import type { AilyAppConfig } from '@shared'

const normalizePlatform = (platform?: string) => {
	const value = String(platform || '').toLowerCase()
	if (value.includes('win')) return 'win32'
	if (value.includes('darwin') || value.includes('mac')) return 'darwin'
	if (value.includes('linux')) return 'linux'
	return value
}

/**
 * 读取当前平台对应的 appdata 路径模板。
 * @param config - 应用配置
 * @param platform - 平台标识
 */
export const getAppDataPathTemplate = (config: AilyAppConfig | null | undefined, platform?: string) => {
	const platformKey = normalizePlatform(platform ?? String(config?.platform || ''))
	if (platformKey === 'win32') return config?.appdata_path?.win32 ?? ''
	if (platformKey === 'darwin') return config?.appdata_path?.darwin ?? ''
	if (platformKey === 'linux') return config?.appdata_path?.linux ?? ''
	return ''
}

/**
 * 将 legacy 模板路径中的 `%HOMEPATH%` 展开为当前用户目录。
 * @param config - 应用配置
 * @param userHome - 用户主目录
 * @param platform - 平台标识
 */
export const resolveAppDataPath = (config: AilyAppConfig | null | undefined, userHome: string, platform?: string) =>
	getAppDataPathTemplate(config, platform).replace('%HOMEPATH%', userHome)

/**
 * 根据用户文档目录生成默认项目根目录。
 * @param userDocuments - 用户文档目录
 * @param separator - 路径分隔符
 */
export const getDefaultProjectRootPath = (userDocuments: string, separator: string) =>
	`${userDocuments}${separator}aily-project${separator}`

/**
 * 解析环境变量模板中的项目根目录。
 * @param template - 原始模板
 * @param userDocuments - 用户文档目录
 * @param separator - 路径分隔符
 */
export const resolveProjectRootPath = (template: string, userDocuments: string, separator: string) =>
	String(template || '').replace('%HOMEPATH%\\Documents\\', `${userDocuments}${separator}`)

/**
 * 根据基础路径和项目名称构建项目目录路径。
 * @param basePath - 基础目录
 * @param inputName - 原始项目名
 * @param separator - 路径分隔符
 */
export const buildProjectDirectoryPath = (basePath: string, inputName: string, separator: string) =>
	`${String(basePath || '').replace(/[\\/]+$/, '')}${separator}${String(inputName || '')
		.trim()
		.replace(/\s/g, '_')}`

/**
 * 规范化项目路径用于比较。
 * @param projectPath - 原始路径
 */
export const normalizeProjectPath = (projectPath: string | null | undefined) =>
	String(projectPath || '')
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.toLowerCase()

/**
 * 判断两个项目路径是否相同。
 * @param leftPath - 左侧路径
 * @param rightPath - 右侧路径
 */
export const isSameProjectPath = (leftPath: string | null | undefined, rightPath: string | null | undefined) =>
	normalizeProjectPath(leftPath) === normalizeProjectPath(rightPath)

import type { AilyAppConfig, ThemeMode } from 'shared'

/**
 * 从配置读取当前主题模式。
 * @param config - 应用配置
 */
export const getThemeMode = (config: AilyAppConfig | null | undefined): ThemeMode =>
	config?.theme === 'light' ? 'light' : 'dark'

/**
 * 把主题模式写回为配置格式。
 * @param config - 应用配置
 * @param mode - 主题模式
 */
export const setThemeMode = (config: AilyAppConfig | null | undefined, mode: ThemeMode): AilyAppConfig => ({
	...(config ?? {}),
	theme: mode === 'dark' ? 'default' : 'light'
})

/**
 * 切换主题模式。
 * @param config - 应用配置
 */
export const toggleThemeMode = (config: AilyAppConfig | null | undefined) =>
	setThemeMode(config, getThemeMode(config) === 'dark' ? 'light' : 'dark')

/**
 * 获取 Monaco 主题名。
 * @param config - 应用配置
 */
export const getMonacoTheme = (config: AilyAppConfig | null | undefined) =>
	getThemeMode(config) === 'dark' ? 'vs-dark' : 'vs'

/**
 * 获取 Mermaid 主题名。
 * @param config - 应用配置
 */
export const getMermaidTheme = (config: AilyAppConfig | null | undefined) =>
	getThemeMode(config) === 'dark' ? 'dark' : 'default'

/**
 * 获取 Blockly 主题标识。
 * @param config - 应用配置
 */
export const getBlocklyThemeId = (config: AilyAppConfig | null | undefined) => getThemeMode(config)

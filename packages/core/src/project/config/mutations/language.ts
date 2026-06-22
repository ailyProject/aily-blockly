import type { AilyAppConfig } from 'shared'

/**
 * 更新当前选中的语言。
 * @param config - 当前应用配置
 * @param selectedLanguage - 新语言
 */
export const setSelectedLanguage = (
	config: AilyAppConfig | null | undefined,
	selectedLanguage: string
): AilyAppConfig => ({
	...(config ?? {}),
	selectedLanguage
})

import { getSkippedVersions } from '../selectors'

import type { AilyAppConfig } from 'shared'

/**
 * 追加一条跳过更新版本记录。
 * @param config - 当前应用配置
 * @param version - 要跳过的版本
 */
export const skipAppVersion = (config: AilyAppConfig | null | undefined, version: string): AilyAppConfig => {
	if (!version) return { ...(config ?? {}) }

	const skippedVersions = getSkippedVersions(config)
	if (!skippedVersions.includes(version)) {
		skippedVersions.push(version)
	}

	return {
		...(config ?? {}),
		skippedVersions
	}
}

/**
 * 清空跳过更新版本列表。
 * @param config - 当前应用配置
 */
export const clearSkippedAppVersions = (config: AilyAppConfig | null | undefined): AilyAppConfig => ({
	...(config ?? {}),
	skippedVersions: []
})

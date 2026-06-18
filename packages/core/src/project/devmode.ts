import type { AilyAppConfig, DevModeConfig } from 'shared'

const defaultDevmode: DevModeConfig = {
	enabled: false,
	autoSave: true
}

/**
 * 归一化 legacy devmode 配置。
 * @param config - 应用配置
 */
export const resolveDevmodeConfig = (config: AilyAppConfig | null | undefined): DevModeConfig => {
	const value = config?.devmode

	if (typeof value === 'boolean') {
		return {
			enabled: value,
			autoSave: true
		}
	}

	return {
		enabled: value?.enabled ?? defaultDevmode.enabled,
		autoSave: value?.autoSave ?? defaultDevmode.autoSave
	}
}

/**
 * 判断 devmode 是否启用。
 * @param config - 应用配置
 */
export const isDevmodeEnabled = (config: AilyAppConfig | null | undefined) => resolveDevmodeConfig(config).enabled

/**
 * 更新 devmode 的 autoSave 开关。
 * @param config - 应用配置
 * @param autoSave - 新 autoSave 值
 */
export const setDevmodeAutoSave = (config: AilyAppConfig | null | undefined, autoSave: boolean): AilyAppConfig => ({
	...(config ?? {}),
	devmode: {
		...resolveDevmodeConfig(config),
		autoSave
	}
})

/**
 * 更新 devmode 的 enabled 开关。
 * @param config - 应用配置
 * @param enabled - 新 enabled 值
 */
export const setDevmodeEnabled = (config: AilyAppConfig | null | undefined, enabled: boolean): AilyAppConfig => ({
	...(config ?? {}),
	devmode: {
		...resolveDevmodeConfig(config),
		enabled
	}
})

/**
 * 同时更新 devmode 两个开关。
 * @param config - 应用配置
 * @param next - 目标 devmode 配置
 */
export const setDevmodeConfig = (
	config: AilyAppConfig | null | undefined,
	next: Partial<DevModeConfig>
): AilyAppConfig => ({
	...(config ?? {}),
	devmode: {
		...resolveDevmodeConfig(config),
		...next
	}
})

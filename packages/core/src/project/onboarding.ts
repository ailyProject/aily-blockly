import type { AilyAppConfig, AppOnboardingKey } from '@shared'

/**
 * 读取应用内 onboarding 完成状态。
 * @param config - 应用配置
 */
export const getOnboardingState = (config: AilyAppConfig | null | undefined) => ({
	onboardingCompleted: config?.onboardingCompleted === true,
	blocklyOnboardingCompleted: config?.blocklyOnboardingCompleted === true,
	ailyChatOnboardingCompleted: config?.ailyChatOnboardingCompleted === true
})

/**
 * 标记某项 onboarding 已完成。
 * @param config - 应用配置
 * @param key - onboarding 标记键
 */
export const completeOnboarding = (config: AilyAppConfig | null | undefined, key: AppOnboardingKey): AilyAppConfig => ({
	...(config ?? {}),
	[key]: true
})

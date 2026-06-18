/**
 * 应用级 onboarding 标记键
 */
export type AppOnboardingKey =
	/** 欢迎页引导 */
	| 'onboardingCompleted'
	/** Blockly 编辑器引导 */
	| 'blocklyOnboardingCompleted'
	/** AI Chat 引导 */
	| 'ailyChatOnboardingCompleted'

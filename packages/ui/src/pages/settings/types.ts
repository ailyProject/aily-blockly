/**
 * 设置页展示快照
 */
export interface SettingsSnapshot {
	/** 当前选中的界面语言 */
	selectedLanguage: string
	/** 当前主题模式 */
	themeMode: string
	/** 当前是否启用开发者模式 */
	devmodeEnabled: boolean
	/** 当前开发者模式自动保存开关 */
	devmodeAutoSave: boolean
	/** 当前 AI 对话模式 */
	aiChatMode: string
	/** 当前选中的模型名称 */
	selectedModel: string | null
	/** 最近项目数量 */
	recentProjectCount: number
	/** 最近模型项目数量 */
	recentModelProjectCount: number
	/** 通用 onboarding 是否完成 */
	onboardingCompleted: boolean
	/** Blockly onboarding 是否完成 */
	blocklyOnboardingCompleted: boolean
	/** Aily Chat onboarding 是否完成 */
	ailyChatOnboardingCompleted: boolean
}

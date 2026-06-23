import type { RegionListItem, ResourceSourceConfig } from 'shared'

/**
 * 设置页展示快照
 */
export interface SettingsSnapshot {
	/** 当前选中的界面语言 */
	selectedLanguage: string
	/** 当前主题模式 */
	themeMode: string
	/** 当前选中的区域 */
	regionKey: string
	/** 当前资源源选择键 */
	resourceSourceKey: string
	/** 当前生效资源源 URL */
	currentResourceSourceUrl: string | null
	/** 当前可选区域数量 */
	enabledRegionCount: number
	/** 当前可用资源源数量 */
	resourceSourceCount: number
	/** 当前可选区域列表 */
	enabledRegions: Array<RegionListItem>
	/** 当前可用资源源列表 */
	resourceSources: Array<ResourceSourceConfig>
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
	/** 当前项目生命周期摘要 */
	projectLifecycle?: {
		projectPath: string
		editorRoute: string
		hasPackageJson: boolean
		hasProjectDocument: boolean
		hasTempDocument: boolean
		hasMutationLock: boolean
		mutationLockStale?: boolean
		mutationLockOwner?: string
		mutationLockPid?: number
		hasOpenSessionLock: boolean
		openSessionLockStale?: boolean
		openSessionLockOwner?: string
		openSessionLockPid?: number
		recoveredFromTemp: boolean
		sourceFilePath?: string
		parseError?: string
		boardPackageName?: string
		boardPackageReady?: boolean
		declaredLibraryCount: number
		readyLibraryCount: number
		missingLibraryCount: number
		codeHash?: string
		buildStatus?: string
		buildTime?: string
		buildDuration?: number
	}
	/** 通用 onboarding 是否完成 */
	onboardingCompleted: boolean
	/** Blockly onboarding 是否完成 */
	blocklyOnboardingCompleted: boolean
	/** Aily Chat onboarding 是否完成 */
	ailyChatOnboardingCompleted: boolean
}

/**
 * 首页硬件分类统计项
 */
export interface HomePageCategoryCount {
	/** 分类显示名称 */
	name: string
	/** 当前分类下的数量 */
	count: number
}

/**
 * 首页板卡表格行
 */
export interface HomeBoardRow {
	/** 开发板名称 */
	name: string
	/** 开发板核心平台 */
	core: string
	/** 当前支持状态 */
	status: string
	/** 最近更新时间 */
	updatedAt: string
}

/**
 * 首页应用配置摘要
 */
export interface HomePageConfigSummary {
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
	/** 当前解析出的模型名称 */
	selectedModel: string | null
	/** 当前工具栏应用总数 */
	toolbarAppCount: number
	/** 当前上下文下可见的工具栏应用数 */
	visibleToolbarAppCount: number
	/** 当前快捷发送条目数 */
	quickSendCount: number
	/** 当前跳过版本条目数 */
	skippedVersionCount: number
	/** 当前串口波特率 */
	serialBaudRate: string
	/** 当前串口视图自动滚动开关 */
	serialAutoScroll: boolean
	/** 当前串口输入十六进制模式开关 */
	serialInputHexMode: boolean
	/** 当前串口连接参数中的波特率 */
	serialConnectBaudRate: number
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
	/** 预览配置解析出的语言 */
	previewSelectedLanguage: string
	/** 预览配置解析出的主题 */
	previewThemeMode: string
	/** 预览配置解析出的开发者模式开关 */
	previewDevmodeEnabled: boolean
	/** 预览配置解析出的自动保存开关 */
	previewDevmodeAutoSave: boolean
	/** 预览配置解析出的串口端口 */
	previewSerialPort: string
	/** 预览配置解析出的 AI 对话模式 */
	previewAiChatMode: string
	/** 预览配置解析出的工具栏应用数 */
	previewToolbarAppCount: number
	/** 预览配置解析出的快捷发送条目数 */
	previewQuickSendCount: number
	/** 预览配置解析出的跳过版本条目数 */
	previewSkippedVersionCount: number
	/** 默认布局中的工具栏应用数 */
	defaultToolbarAppCount: number
	/** 合并可见顺序后的工具栏应用数 */
	mergedToolbarOrderCount: number
	/** toggle 动作后的工具栏应用数 */
	toggledToolbarAppCount: number
	/** reset 动作后的工具栏应用数 */
	resetToolbarAppCount: number
	/** add recent project 后的项目数量 */
	addedRecentProjectCount: number
	/** remove recent project 后的项目数量 */
	removedRecentProjectCount: number
	/** 预览写回后的 Aily Chat onboarding 状态 */
	previewAilyChatOnboardingCompleted: boolean
	/** add recent model project 后的项目数量 */
	addedRecentModelProjectCount: number
	/** remove recent model project 后的项目数量 */
	removedRecentModelProjectCount: number
}

/**
 * 首页 legacy 校验结果
 */
export interface HomePageValidationState {
	/** 是否在索引中找到匹配项 */
	exists: boolean
	/** 是否通过模糊匹配得到结果 */
	fuzzyMatch: boolean
	/** 最终命中的条目名称 */
	matchedName: string | null
}

/**
 * 首页安全选项摘要
 */
export interface HomePageSecurityOption {
	/** 安全项名称 */
	name: string
	/** 当前是否启用 */
	enabled: boolean
}

/**
 * 首页用于展示的 core/rpc 派生状态
 */
export interface HomePageCoreState {
	/** 开发板按架构分类后的数量摘要 */
	architectureCategories: Array<HomePageCategoryCount>
	/** legacy 开发板校验结果 */
	boardValidation: HomePageValidationState
	/** legacy 库校验结果 */
	libraryValidation: HomePageValidationState
	/** 启用模型数量 */
	enabledModelCount: number
	/** 工作区安全选项摘要 */
	securityOptions: Array<HomePageSecurityOption>
	/** 语言、主题、串口和 onboarding 等配置摘要 */
	configSummary: HomePageConfigSummary
}

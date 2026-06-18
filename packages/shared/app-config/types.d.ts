import type { AgentModelConfigOption } from '../agent'
import type {
	BoardUsageCountMap,
	BuildFlavor,
	RecentlyProjectEntry,
	RegionConfigMap,
	ResourceSourceConfig
} from '../project'
import type {
	AppDataPathConfig,
	BlocklyConfig,
	BuildStepOptionsConfig,
	DevModeConfig,
	ThemeMode,
	UpdateDownloadStrategyConfig
} from './base'
import type { RecentModelProject } from './model-project'
import type { QuickSendItem, SerialMonitorConfig } from './serial'

export type {
	AppDataPathConfig,
	BlocklyConfig,
	BuildStepOptionsConfig,
	DevModeConfig,
	ThemeMode,
	UpdateDownloadStrategyConfig
} from './base'

export type {
	QuickSendItem,
	SerialMonitorConfig,
	SerialMonitorConnectOptions,
	SerialMonitorInputMode,
	SerialMonitorViewMode
} from './serial'
/**
 * AI 聊天模式
 */
export type AilyAiChatMode =
	/** Agent 自主调用工具模式 */
	| 'agent'
	/** 纯问答模式 */
	| 'ask'
/**
 * Aily 应用级配置模型
 */
export interface AilyAppConfig {
	/** 当前语言 */
	lang?: string
	/** UI 主题 */
	theme?: ThemeMode | 'default'
	/** 字体设置 */
	font?: string
	/** 当前平台类型 */
	platform?: string
	/** 项目数据默认路径配置 */
	appdata_path?: AppDataPathConfig
	/** 项目默认路径 */
	project_path?: string
	/** 打包版型 */
	build_flavor?: BuildFlavor
	/** 当前版型允许的官方区域 */
	official_region?: string
	/** 当前选中的区域 */
	region?: string
	/** 当前选中的资源源 */
	resource_source?: string
	/** 资源源列表 */
	resource_sources?: Array<ResourceSourceConfig>
	/** 区域配置 */
	regions?: RegionConfigMap
	/** 更新下载镜像策略 */
	update_download_strategy?: UpdateDownloadStrategyConfig
	/** 编译选项 */
	compile?: BuildStepOptionsConfig
	/** 上传选项 */
	upload?: BuildStepOptionsConfig
	/** 开发模式配置 */
	devmode?: DevModeConfig
	/** Blockly 运行时配置 */
	blockly?: BlocklyConfig
	/** 串口监视器快速发送列表 */
	quickSendList?: Array<QuickSendItem>
	/** 最近打开的模型项目列表 */
	recentModelProjects?: Array<RecentModelProject>
	/** 最近打开的项目列表 */
	recentlyProjects?: Array<RecentlyProjectEntry>
	/** 首页 onboarding 是否已完成 */
	onboardingCompleted?: boolean
	/** Blockly onboarding 是否已完成 */
	blocklyOnboardingCompleted?: boolean
	/** Aily Chat onboarding 是否已完成 */
	ailyChatOnboardingCompleted?: boolean
	/** 当前选择的语言 */
	selectedLanguage?: string
	/** Header toolbar app ids */
	toolbarAppIds?: Array<string>
	/** 跳过更新的版本列表 */
	skippedVersions?: Array<string>
	/** 开发板使用次数统计 */
	boardUsageCount?: BoardUsageCountMap
	/** AI 聊天模式 */
	aiChatMode?: AilyAiChatMode
	/** AI 聊天当前模型 */
	aiChatModel?: AgentModelConfigOption
	/** 串口监视器配置 */
	serialMonitor?: SerialMonitorConfig
	/** 保留其它 legacy 配置字段 */
	[key: string]: unknown
}

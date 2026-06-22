import type {
	AilyAiChatMode,
	DevModeConfig,
	QuickSendItem,
	SerialMonitorConfig,
	SerialMonitorInputMode,
	SerialMonitorViewMode,
	ThemeMode
} from 'shared'

/**
 * `core.config.get` 返回的配置摘要。
 */
export interface ConfigSummary {
	/** 当前选中的界面语言。 */
	selectedLanguage: string
	/** 当前生效的主题模式。 */
	themeMode: ThemeMode
	/** Monaco 编辑器应使用的主题标识。 */
	monacoTheme: string
	/** Mermaid 图表应使用的主题标识。 */
	mermaidTheme: string
	/** Blockly 工作区应使用的主题标识。 */
	blocklyThemeId: string
	/** 当前是否处于开发者模式。 */
	devmodeEnabled: boolean
	/** 归一化后的开发者模式配置。 */
	devmode: DevModeConfig
	/** 当前平台对应的应用数据目录模板字符串。 */
	appDataPathTemplate: string
	/** 结合用户目录解析后的应用数据路径。 */
	appDataPath: string
	/** 当前区域解析出的 npm registry。 */
	npmRegistry: string
	/** 当前工具栏应用标识列表。 */
	toolbarAppIds: Array<string>
	/** 当前跳过更新的版本列表。 */
	skippedVersions: Array<string>
	/** 当前 AI 聊天模式。 */
	aiChatMode: AilyAiChatMode
	/** 当前串口快捷发送列表。 */
	quickSendList: Array<QuickSendItem>
	/** 补齐默认值后的串口监视器持久化配置。 */
	serialMonitor: Required<SerialMonitorConfig>
	/** 当前串口监视器视图模式默认值。 */
	serialViewMode: SerialMonitorViewMode
	/** 当前串口监视器输入模式默认值。 */
	serialInputMode: SerialMonitorInputMode
}

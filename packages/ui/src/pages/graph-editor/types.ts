import type { SafeResourceUrl } from '@angular/platform-browser'

/**
 * Sensor picker 中的型号分组。
 */
export interface GraphEditorSensorPickerGroup {
	/** 库显示名。 */
	displayName: string
	/** 型号列表。 */
	models: Array<{
		/** 型号标识。 */
		id: string
		/** 型号名称。 */
		name: string
		/** 变体列表。 */
		variants: Array<{
			/** 完整 pinmapId。 */
			fullId: string
			/** 变体名称。 */
			name: string
			/** 协议类型。 */
			protocol?: string
			/** 当前状态。 */
			status: 'available' | 'needs_generation'
			/** 是否默认变体。 */
			isDefault?: boolean
		}>
	}>
}

/**
 * Graph editor 页面展示的库信息摘要。
 */
export interface GraphEditorLibraryInfo {
	/** README 摘要文本。 */
	readme: string
	/** 示例代码摘要。 */
	exampleCode: string
	/** 当前目录下已有的 pinmap 文件列表。 */
	existingPinmaps: Array<string>
}

/**
 * 连线图页面展示的 prompt 摘要。
 */
export interface GraphEditorPromptInfo {
	/** 面向 wiring assistant 的 system prompt。 */
	systemPrompt: string
	/** 拼装后的 user prompt。 */
	userPrompt: string
	/** 当前用于 prompt 的 pin summary 数量。 */
	pinSummaryCount: number
}

/**
 * 连线图页面展示状态
 */
export interface GraphEditorState {
	/** 当前项目路径。 */
	projectPath: string
	/** 当前项目依赖根路径。 */
	packagesBasePath: string
	/** 当前项目声明的开发板包名。 */
	boardPackageName: string
	/** 当前开发板包路径。 */
	boardPackagePath: string
	/** 当前连线图标题 */
	title: string
	/** 当前实际加载的 URL */
	url: string
	/** 当前 URL 对应的源 */
	origin: string
	/** 可绑定到 iframe 的安全资源 URL */
	frameUrl: SafeResourceUrl
	/** 连线图 JSON 文件路径 */
	jsonPath: string
	/** 连线图 AWS 文件路径 */
	awsPath: string
	/** 当前是否存在连线图 JSON */
	graphExists: boolean
	/** 当前是否存在 AWS 源文件 */
	awsExists: boolean
	/** 当前连线图描述 */
	graphDescription: string
	/** 当前连线图组件数量 */
	componentCount: number
	/** 当前连线数量 */
	connectionCount: number
	/** 当前 AWS 文本行数 */
	awsLineCount: number
	/** 扫描到的库数量。 */
	libraryCount: number
	/** 扫描到的 catalog 数量。 */
	catalogCount: number
	/** 缺少 catalog 的库数量。 */
	missingCatalogCount: number
	/** 已发现的库名称列表。 */
	libraryNames: Array<string>
	/** 缺少 catalog 的库名称列表。 */
	missingCatalogNames: Array<string>
	/** 当前可用的 pinmapId 列表。 */
	availablePinmapIds: Array<string>
	/** 当前 sensor picker 数据。 */
	sensorPickerGroups: Array<GraphEditorSensorPickerGroup>
	/** 当前 pinmap template 预览协议。 */
	pinmapTemplateProtocol: string
	/** 当前 pinmap template JSON。 */
	pinmapTemplateJson: string
	/** 当前 graph JSON 文本。 */
	graphJson: string
	/** 当前 AWS 文本。 */
	awsContent: string
	/** 当前 graph JSON 中提取出的 pinmapId 提示列表。 */
	pinmapHints: Array<string>
	/** 当前 pinmapId 对应的库信息。 */
	libraryInfo: GraphEditorLibraryInfo
	/** 当前连线提示词摘要。 */
	promptInfo: GraphEditorPromptInfo
	/** 当前连线图组件配置映射 JSON。 */
	componentConfigsJson: string
}

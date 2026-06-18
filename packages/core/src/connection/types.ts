/**
 * 连线端点
 */
export interface ConnectionEndpoint {
	/** 组件引用标识 */
	ref: string
	/** 引脚标识 */
	pinId: string
	/** 引脚功能名称 */
	function: string
}

/**
 * 连线定义
 */
export interface ConnectionDef {
	/** 连线唯一标识 */
	id: string
	/** 起点端点 */
	from: ConnectionEndpoint
	/** 终点端点 */
	to: ConnectionEndpoint
	/** 连线类型 */
	type: string
	/** 是否为半连接 */
	half?: boolean
	/** 连线显示标签 */
	label: string
	/** 连线颜色 */
	color: string
	/** 备注信息 */
	note?: string
}

/**
 * 组件类型
 */
export type ConnectionComponentType =
	/** 有引脚的硬件组件 */
	| 'hardware'
	/** 无引脚的软件组件 */
	| 'software'

/**
 * 连线图中的组件引用
 */
export interface ConnectionComponent {
	/** 组件引用标识 */
	refId: string
	/** 组件原始标识 */
	componentId: string
	/** 组件显示名称 */
	componentName: string
	/** 组件配置文件路径 */
	configFile?: string
	/** pinmap 完整标识符 */
	pinmapId?: string
	/** 同 pinmap 的实例序号 */
	instance?: number
	/** 组件类型 */
	componentType?: ConnectionComponentType
	/** 软件组件附加配置 */
	softwareConfig?: Record<string, unknown>
}

/**
 * 连线图数据
 */
export interface ConnectionGraphData {
	/** 数据格式版本 */
	version: string
	/** 连线图说明文本 */
	description: string
	/** 组件引用列表 */
	components: Array<ConnectionComponent>
	/** 连线列表 */
	connections: Array<ConnectionDef>
}

/**
 * 组件配置
 */
export interface ConnectionComponentConfig {
	/** 组件唯一标识 */
	id: string
	/** 组件显示名称 */
	name: string
	/** 配置原始载荷 */
	[key: string]: unknown
}

/**
 * 连线图 iframe 载荷
 */
export interface ConnectionGraphPayload {
	/** 组件配置映射 */
	componentConfigs: Record<string, ConnectionComponentConfig>
	/** 组件引用列表 */
	components: Array<ConnectionComponent>
	/** 连线列表 */
	connections: Array<ConnectionDef>
	/** 页面主题 */
	theme?: 'light' | 'dark'
}

/**
 * 连线校验级别
 */
export type ConnectionValidationLevel =
	/** 阻断性错误 */
	| 'error'
	/** 可继续但需留意的问题 */
	| 'warning'

/**
 * 连线校验结果
 */
export interface ConnectionValidationResult {
	/** 规则标识 */
	ruleId: string
	/** 结果级别 */
	level: ConnectionValidationLevel
	/** 问题描述 */
	message: string
}

/**
 * 连线图文件路径集合
 */
export interface ConnectionGraphPaths {
	/** JSON 输出文件路径 */
	jsonPath: string
	/** AWS 源文件路径 */
	awsPath: string
}

/**
 * 组件图片
 */
export interface ConnectionComponentImage {
	/** 图片地址 */
	url: string
	/** 图片横向坐标 */
	x: number
	/** 图片纵向坐标 */
	y: number
	/** 图片宽度 */
	width: number
	/** 图片高度 */
	height: number
}

/**
 * 引脚功能
 */
export interface ConnectionPinFunction {
	/** 功能名称 */
	name: string
	/** 功能类型 */
	type: string
	/** 当前是否可见 */
	visible?: boolean
	/** 当前是否禁用 */
	disabled?: boolean
}

/**
 * 组件配置中的引脚
 */
export interface ConnectionConfigPin {
	/** 引脚唯一标识 */
	id: string
	/** 引脚横向坐标 */
	x: number
	/** 引脚纵向坐标 */
	y: number
	/** 标签布局方向 */
	layout: 'horizontal' | 'vertical'
	/** 当前引脚支持的功能列表 */
	functions: Array<ConnectionPinFunction>
	/** 当前是否可见 */
	visible?: boolean
	/** 当前是否禁用 */
	disabled?: boolean
}

/**
 * 组件完整配置
 */
export interface ConnectionPinmapConfig extends ConnectionComponentConfig {
	/** 组件宽度 */
	width: number
	/** 组件高度 */
	height: number
	/** 图片资源 */
	images: Array<ConnectionComponentImage>
	/** 引脚列表 */
	pins: Array<ConnectionConfigPin>
}

/**
 * 引脚摘要
 */
export interface ConnectionPinSummary {
	/** 组件原始标识 */
	componentId: string
	/** 组件显示名称 */
	componentName: string
	/** 可用引脚数量 */
	pinCount: number
	/** 引脚摘要列表 */
	pins: Array<{
		/** 引脚唯一标识 */
		id: string
		/** 可见功能列表 */
		functions: Array<{ name: string; type: string }>
	}>
}

/**
 * 传感器变体
 */
export interface ConnectionPinmapVariant {
	/** 变体标识 */
	id: string
	/** 变体显示名称 */
	name: string
	/** 完整 pinmapId */
	fullId: string
	/** pinmap 文件相对路径 */
	pinmapFile?: string
	/** 共享 pinmap 引用 */
	pinmapRef?: string
	/** 当前状态 */
	status: 'available' | 'needs_generation'
	/** 协议类型 */
	protocol?: string
	/** 是否默认变体 */
	isDefault?: boolean
}

/**
 * 传感器型号
 */
export interface ConnectionPinmapModel {
	/** 型号标识 */
	id: string
	/** 型号显示名称 */
	name: string
	/** 变体列表 */
	variants: Array<ConnectionPinmapVariant>
}

/**
 * 共享 pinmap 定义
 */
export interface ConnectionSharedPinmapDef {
	/** 共享 pinmap 文件相对路径 */
	file: string
}

/**
 * pinmap 目录
 */
export interface ConnectionPinmapCatalog {
	/** 目录版本 */
	version: string
	/** 库标识 */
	library: string
	/** 目录显示名称 */
	displayName: string
	/** 目录类型 */
	type?: 'library' | 'board' | 'software'
	/** 图标名称 */
	icon?: string
	/** 型号列表 */
	models: Array<ConnectionPinmapModel>
	/** 共享 pinmap 映射 */
	sharedPinmaps?: Record<string, ConnectionSharedPinmapDef>
}

/**
 * pinmap 标识解析结果
 */
export interface ConnectionPinmapReference {
	/** 完整标识符 */
	fullId: string
	/** 包标识 */
	packageSlug: string
	/** 型号标识 */
	modelId: string
	/** 变体标识 */
	variantId: string
}

/**
 * 连线图 prompt 结果
 */
export interface ConnectionPromptBundle {
	/** system prompt */
	systemPrompt: string
	/** user prompt */
	userPrompt: string
	/** 当前参与 prompt 的引脚摘要 */
	pinSummaries: Array<ConnectionPinSummary>
}

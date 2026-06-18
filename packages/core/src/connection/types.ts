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

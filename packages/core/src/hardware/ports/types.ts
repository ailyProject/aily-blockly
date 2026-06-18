/**
 * 串口宿主平台
 */
export type HardwareSerialPlatform =
	/** Windows 平台 */
	| 'windows'
	/** macOS 平台 */
	| 'macos'
	/** Linux 平台 */
	| 'linux'
	/** 浏览器 Web Serial 环境 */
	| 'web'

/**
 * 原始串口枚举项
 */
export interface HardwareRawSerialPortItem {
	/** 原始设备路径 */
	path?: string
	/** 友好名称 */
	friendlyName?: string
	/** 厂商名称 */
	manufacturer?: string
	/** Vendor ID */
	vendorId?: string
	/** Product ID */
	productId?: string
	/** 透传原始字段 */
	[key: string]: unknown
}

/**
 * 规范化后的串口条目
 */
export interface HardwareSerialPortItem {
	/** 运行时端口句柄 */
	port?: unknown
	/** 设备路径或端口名称 */
	name?: string
	/** 面向用户展示的文本 */
	text?: string
	/** 条目类型 */
	type?: string
	/** 图标名称 */
	icon?: string
	/** 当前是否禁用 */
	disabled?: boolean
	/** debugger 对应的 probe serial */
	probeSerial?: string
	/** debugger 对应的 probe vid:pid */
	probeVidPid?: string
	/** 附加动作 */
	action?: string
	/** 是否分隔项 */
	sep?: boolean
	/** 扩展载荷 */
	extra?: unknown
	/** 是否为当前选中项 */
	current?: boolean
}

/**
 * 串口列表结果
 */
export interface HardwareSerialListResult {
	/** 当前能力是否可用 */
	available: boolean
	/** 当前宿主平台 */
	platform: HardwareSerialPlatform
	/** 串口列表 */
	ports: Array<HardwareSerialPortItem>
	/** 错误文本 */
	error?: string
}

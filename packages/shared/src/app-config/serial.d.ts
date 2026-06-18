/**
 * 串口监视器快速发送项类型
 */
export type QuickSendItemType =
	/** 串口控制信号 */
	| 'signal'
	/** 纯文本发送 */
	| 'text'
	/** Hex 文本发送 */
	| 'hex'
/**
 * 串口监视器快速发送项
 */
export interface QuickSendItem {
	/** 展示名称 */
	name: string
	/** 发送项类型 */
	type: QuickSendItemType
	/** 实际发送内容 */
	data: string
}
/**
 * 串口监视器持久化配置
 */
export interface SerialMonitorConfig {
	/** 上次选择的串口名 */
	port?: string
	/** 上次选择的波特率 */
	baudRate?: string
	/** 数据位 */
	dataBits?: string
	/** 停止位 */
	stopBits?: string
	/** 校验位 */
	parity?: string
	/** 流控制 */
	flowControl?: string
}
/**
 * 串口监视器视图模式
 */
export interface SerialMonitorViewMode {
	/** 是否显示 Hex 视图 */
	showHex: boolean
	/** 是否显示控制字符 */
	showCtrlChar: boolean
	/** 是否自动换行 */
	autoWrap: boolean
	/** 是否自动滚动到底部 */
	autoScroll: boolean
	/** 是否显示时间戳 */
	showTimestamp: boolean
}
/**
 * 串口监视器输入模式
 */
export interface SerialMonitorInputMode {
	/** 是否以 Hex 模式输入 */
	hexMode: boolean
	/** 是否按回车直接发送 */
	sendByEnter: boolean
	/** 是否追加回车符 */
	endR: boolean
	/** 是否追加换行符 */
	endN: boolean
}
/**
 * 串口连接选项
 */
export interface SerialMonitorConnectOptions {
	/** 串口路径 */
	path: string
	/** 波特率 */
	baudRate: number
	/** 数据位 */
	dataBits: number
	/** 停止位 */
	stopBits: number
	/** 校验位 */
	parity: string
	/** 流控制 */
	flowControl: string
}

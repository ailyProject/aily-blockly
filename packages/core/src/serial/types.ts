import type { SerialMonitorConnectOptions } from 'shared'

/**
 * 串口消息方向。
 */
export type SerialMessageDirection =
	/** 接收数据。 */
	| 'rx'
	/** 发送数据。 */
	| 'tx'
	/** 系统消息。 */
	| 'sys'

/**
 * 串口会话消息。
 */
export interface SerialSessionMessage {
	/** 消息方向。 */
	direction: SerialMessageDirection
	/** 记录时间。 */
	timestamp: string
	/** 文本预览。 */
	text: string
	/** 十六进制预览。 */
	hex: string
}

/**
 * 串口控制信号类型。
 */
export type SerialSignalKind =
	/** DTR 控制信号。 */
	| 'dtr'
	/** RTS 控制信号。 */
	| 'rts'

/**
 * 串口会话快照。
 */
export interface SerialSessionSnapshot {
	/** 当前会话端口。 */
	port: string
	/** 当前会话是否已连接。 */
	connected: boolean
	/** 当前连接参数。 */
	options: SerialMonitorConnectOptions
	/** 当前缓冲消息数量。 */
	bufferedMessages: number
}

/**
 * 串口发送模式。
 */
export type SerialSendMode =
	/** 按 UTF-8 文本发送。 */
	| 'text'
	/** 按十六进制字节发送。 */
	| 'hex'

/**
 * 串口发送载荷。
 */
export interface SerialSendPayloadInput {
	/** 原始发送内容。 */
	data: string
	/** 发送模式。 */
	mode: SerialSendMode
	/** 是否追加回车。 */
	endR?: boolean
	/** 是否追加换行。 */
	endN?: boolean
}

/**
 * 串口发送输入。
 */
export interface SerialSendInput extends SerialSendPayloadInput {
	/** 当前端口。 */
	port: string
}

/**
 * 串口控制信号输入。
 */
export interface SerialSignalInput {
	/** 当前端口。 */
	port: string
	/** 要切换的控制信号。 */
	signal: SerialSignalKind
	/** 目标状态；未传时按当前缓存状态取反。 */
	enabled?: boolean
}

/**
 * 串口发送结果。
 */
export interface SerialSendResult {
	/** 当前发送是否成功。 */
	success: boolean
	/** 本次发送的字节数。 */
	bytes: number
}

/**
 * 串口控制信号结果。
 */
export interface SerialSignalResult {
	/** 当前操作是否成功。 */
	success: boolean
	/** 已写入的控制信号。 */
	signal: SerialSignalKind
	/** 当前信号状态。 */
	enabled: boolean
}

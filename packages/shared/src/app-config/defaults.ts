import type {
	AilyAiChatMode,
	QuickSendItem,
	SerialMonitorConfig,
	SerialMonitorInputMode,
	SerialMonitorViewMode
} from './types'

/**
 * 默认 AI 聊天模式
 */
export const DEFAULT_AI_CHAT_MODE: AilyAiChatMode = 'agent'

/**
 * 默认快速发送列表
 */
export const DEFAULT_QUICK_SEND_LIST: Array<QuickSendItem> = [
	{ name: 'DTR', type: 'signal', data: 'DTR' },
	{ name: 'RTS', type: 'signal', data: 'RTS' },
	{ name: '发送文本', type: 'text', data: 'This is aily blockly' },
	{ name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
]

/**
 * 默认串口监视器持久化配置
 */
export const DEFAULT_SERIAL_MONITOR_CONFIG: SerialMonitorConfig = {
	baudRate: '9600',
	dataBits: '8',
	stopBits: '1',
	parity: 'none',
	flowControl: 'none'
}

/**
 * 默认串口监视器视图模式
 */
export const DEFAULT_SERIAL_MONITOR_VIEW_MODE: SerialMonitorViewMode = {
	showHex: false,
	showCtrlChar: false,
	autoWrap: true,
	autoScroll: true,
	showTimestamp: true
}

/**
 * 默认串口监视器输入模式
 */
export const DEFAULT_SERIAL_MONITOR_INPUT_MODE: SerialMonitorInputMode = {
	hexMode: false,
	sendByEnter: false,
	endR: true,
	endN: true
}

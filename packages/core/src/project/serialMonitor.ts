import {
	DEFAULT_SERIAL_MONITOR_CONFIG,
	DEFAULT_SERIAL_MONITOR_INPUT_MODE,
	DEFAULT_SERIAL_MONITOR_VIEW_MODE
} from 'shared'

import type {
	AilyAppConfig,
	SerialMonitorConfig,
	SerialMonitorConnectOptions,
	SerialMonitorInputMode,
	SerialMonitorViewMode
} from 'shared'

/**
 * 返回带默认值的串口监视器持久化配置。
 * @param config - 应用配置
 */
export const resolveSerialMonitorConfig = (
	config: AilyAppConfig | null | undefined
): Required<SerialMonitorConfig> => ({
	port: config?.serialMonitor?.port ?? '',
	baudRate: config?.serialMonitor?.baudRate ?? DEFAULT_SERIAL_MONITOR_CONFIG.baudRate ?? '9600',
	dataBits: config?.serialMonitor?.dataBits ?? DEFAULT_SERIAL_MONITOR_CONFIG.dataBits ?? '8',
	stopBits: config?.serialMonitor?.stopBits ?? DEFAULT_SERIAL_MONITOR_CONFIG.stopBits ?? '1',
	parity: config?.serialMonitor?.parity ?? DEFAULT_SERIAL_MONITOR_CONFIG.parity ?? 'none',
	flowControl: config?.serialMonitor?.flowControl ?? DEFAULT_SERIAL_MONITOR_CONFIG.flowControl ?? 'none'
})

/**
 * 返回串口监视器默认视图模式。
 */
export const getDefaultSerialMonitorViewMode = (): SerialMonitorViewMode => ({
	...DEFAULT_SERIAL_MONITOR_VIEW_MODE
})

/**
 * 返回串口监视器默认输入模式。
 */
export const getDefaultSerialMonitorInputMode = (): SerialMonitorInputMode => ({
	...DEFAULT_SERIAL_MONITOR_INPUT_MODE
})

/**
 * 根据持久化配置生成串口连接选项。
 * @param config - 串口监视器配置
 * @param port - 覆盖端口路径
 */
export const buildSerialMonitorConnectOptions = (
	config: SerialMonitorConfig,
	port = config.port ?? ''
): SerialMonitorConnectOptions => {
	const normalized = resolveSerialMonitorConfig({ serialMonitor: config })

	return {
		path: port,
		baudRate: Number.parseInt(normalized.baudRate, 10),
		dataBits: Number.parseInt(normalized.dataBits, 10),
		stopBits: Number.parseFloat(normalized.stopBits),
		parity: normalized.parity,
		flowControl: normalized.flowControl
	}
}

/**
 * WebSerial 风格的串口打开参数。
 */
export interface FfsNodeSerialOpenOptions {
	/** 目标波特率。 */
	baudRate?: number
	/** 数据位。 */
	dataBits?: number
	/** 停止位。 */
	stopBits?: number
	/** 校验位。 */
	parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
	/** 底层缓冲区大小。 */
	bufferSize?: number
	/** 流控方式。 */
	flowControl?: 'none' | 'hardware'
}

/**
 * Node 串口适配器初始化参数。
 */
export interface FfsNodeSerialPortAdapterOptions {
	/** 串口路径。 */
	path: string
	/** 透传到底层 `serialport` 的额外选项。 */
	extra?: Record<string, unknown>
}

/**
 * FFS ESP 会话连接参数。
 */
export interface FfsEspSessionConnectOptions {
	/** 串口路径。 */
	portPath: string
	/** 用户请求的目标波特率。 */
	baudRate: number
	/** 日志输出回调。 */
	onLog?: (message: string) => void
	/** 波特率被自动调整时的通知回调。 */
	onBaudResolved?: (result: import('./types').FfsResolvedBaudrate, portPath: string) => void
}

/**
 * ESP 设备基础信息。
 */
export interface FfsEspChipInfo {
	/** 芯片名称。 */
	chipName: string
	/** Flash 容量展示值。 */
	flashSize?: string
	/** MAC 地址。 */
	mac?: string
	/** 芯片描述。 */
	description?: string
	/** 芯片能力列表。 */
	features?: Array<string>
	/** 晶振频率。 */
	crystalFreq?: number
}

/**
 * Flash 读取进度回调。
 */
export type FfsReadFlashProgress = (received: number, total: number) => void

/**
 * Flash 写入进度回调。
 */
export type FfsWriteFlashProgress = (written: number, total: number) => void

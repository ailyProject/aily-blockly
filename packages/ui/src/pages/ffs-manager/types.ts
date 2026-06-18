/**
 * Flash FS 页面串口摘要
 */
export interface FfsManagerSerialSummary {
	/** 当前串口端口 */
	port: string
	/** 当前串口波特率 */
	baudRate: string
}

/**
 * Flash FS 页面连接参数摘要
 */
export interface FfsManagerConnectSummary {
	/** 准备连接的串口路径 */
	path: string
	/** 准备连接的波特率 */
	baudRate: number
}

/**
 * Flash FS 页面波特率解析摘要
 */
export interface FfsManagerBaudSummary {
	/** 用户原始请求的波特率 */
	requestedBaudRate: number
	/** 当前最终应使用的波特率 */
	resolvedBaudRate: number
	/** 当前是否发生自动降速 */
	capped: boolean
	/** 探测到的桥接芯片显示名 */
	bridgeName: string
}

/**
 * Flash FS 页面展示状态
 */
export interface FfsManagerState {
	/** 当前串口摘要 */
	serial: FfsManagerSerialSummary
	/** 当前准备连接参数 */
	connect: FfsManagerConnectSummary
	/** 当前波特率解析摘要 */
	baud: FfsManagerBaudSummary
	/** 当前宿主可见串口数量 */
	serialPortCount: number
}

/**
 * Probe-rs 设备信息
 */
export interface HardwareProbeRsProbe {
	/** probe 索引 */
	index: number | null
	/** probe 名称 */
	name?: string
	/** vid:pid */
	vidPid?: string
	/** 序列号 */
	serial?: string | null
	/** 短序列号 */
	shortSerial?: string | null
	/** probe 类型 */
	type?: string
	/** 原始文本 */
	raw?: string
}

/**
 * Probe-rs 下载参数
 */
export interface HardwareProbeRsDownloadOptions {
	/** 固件路径 */
	firmwarePath: string
	/** 芯片名称 */
	chip?: string
	/** probe 标识，格式 vid:pid[:serial] */
	probe?: string
	/** 协议 */
	protocol?: string
	/** 速度 */
	speed?: number
	/** 文件格式 */
	format?: string
	/** 起始地址 */
	baseAddress?: number
	/** 跳过字节数 */
	skipBytes?: number
	/** 是否校验 */
	verify?: boolean
}

/**
 * Probe-rs 列表结果
 */
export interface HardwareProbeRsListResult {
	/** 当前是否成功 */
	success: boolean
	/** 设备数量 */
	count?: number
	/** probe 列表 */
	probes?: Array<HardwareProbeRsProbe>
	/** 错误文本 */
	error?: string
	/** 详细输出 */
	detail?: string | null
}

/**
 * Probe-rs 下载结果
 */
export interface HardwareProbeRsDownloadResult {
	/** 当前是否成功 */
	success: boolean
	/** 固件路径 */
	firmware?: string
	/** 芯片名称 */
	chip?: string
	/** 消息文本 */
	message?: string
	/** 错误文本 */
	error?: string
	/** 详细输出 */
	detail?: string | null
}
